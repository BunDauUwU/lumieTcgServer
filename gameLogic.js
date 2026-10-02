import { EffectEngine, list } from "./effectEngine.js";
import { cards, characters, findEntry, pointCost } from "./gameData.js";

export function skillMaxUse(skill) {
    return Number.isInteger(skill.maxUse) && skill.maxUse >= 0 ? skill.maxUse : 1;
}
export function resetRoundLimits(player) {
    player.switchesUsed = 0;
    for (const character of player.characters) {
        character.skillUses = {};
        character.ultimateUsed = false;
        character.elementalSkillUsed = false;
    }
}

function sync(target, source) {
    for (const key of Object.keys(target)) if (!(key in source)) delete target[key];
    for (const [key, value] of Object.entries(source)) {
        if (
            value &&
            typeof value === "object" &&
            target[key] &&
            typeof target[key] === "object" &&
            Array.isArray(value) === Array.isArray(target[key])
        )
            sync(target[key], value);
        else target[key] = structuredClone(value);
    }
    if (Array.isArray(source)) target.length = source.length;
}
function transaction(match, action) {
    const trial = { ...match, players: structuredClone(match.players) };
    const engine = new EffectEngine(trial);
    let result;
    try {
        result = action(trial, engine);
    } catch (exception) {
        return error("EffectError", `Unable to resolve effect: ${exception.message}`);
    }
    if (result.error) return result;
    sync(match.players, trial.players);
    return { ...result, events: engine.events };
}
const sameWeapon = (a, b) => String(a).toUpperCase() === String(b).toUpperCase();
const error = (code, message) => ({ error: [code, message] });

function skillAction(match, playerIndex, command, engine, options = {}) {
    const owner = match.players[playerIndex],
        actor = owner.characters[owner.activeCharacterIndex];
    if (!actor || actor.hp <= 0) return error("DefeatedCharacter", "Choose a living active character first");
    const char = findEntry(characters, actor.characterId);
    if (!char) return error("UnknownCharacter", `Character data not found: ${actor.characterId}`);
    const entries = Object.entries(char[1].skills || {}),
        index = Number(command.skillIndex);
    if (!Number.isInteger(index) || !entries[index]) return error("UnknownSkill", "Skill index is invalid");
    const [name, skill] = entries[index];
    if (list(skill.type).includes("Passive Skill"))
        return error("PassiveSkill", "Passive skills activate automatically");
    if (match.attackDisabled) return error("WeatherRestriction", "Sandstorm prevents attacks this round");
    if (owner.states.some(s => s.name === "Frozen" && s.characterIndex === owner.activeCharacterIndex))
        return error("Frozen", "This character is Frozen until the end of the round");
    if (actor.preparedSkill && actor.preparedSkill !== name)
        return error("PreparedSkill", `Use the prepared skill: ${actor.preparedSkill}`);
    const used = actor.skillUses?.[name] || 0;
    if (used >= skillMaxUse(skill))
        return error("SkillUseLimit", "This skill has reached its use limit for this round");
    const ctx = engine.context(playerIndex, {
        skillName: name,
        definition: skill,
        cost: pointCost(skill.cost),
        energyGain: 1,
        tags: owner.elementPoints % 2 === 0 ? ["CHARGED_ATTACK"] : [],
    });
    ctx.costOnly = true;
    engine.trigger(playerIndex, "use_skill", ctx);
    delete ctx.costOnly;
    engine.trigger(playerIndex, "before_skill_cost", ctx);
    engine.trigger(playerIndex, "skill_cost", ctx);
    engine.trigger(playerIndex, "cost", ctx);
    const energy = Number(skill.cost?.ENERGY || 0);
    if (!options.paidByCard && ctx.cost > owner.elementPoints)
        return error("InsufficientElementPoints", "Not enough element points");
    if (!options.paidByCard && energy > actor.energy) return error("InsufficientEnergy", "Not enough Energy");

    if (!options.paidByCard) {
        owner.elementPoints -= ctx.cost;
        actor.energy -= energy;
    }
    actor.skillUses = { ...actor.skillUses, [name]: used + 1 };
    const burst = list(skill.type).includes("Elemental Burst");
    if (burst) actor.ultimateUsed = true;
    engine.events.push({
        eventType: "SkillUsed",
        playerIndex,
        characterIndex: owner.activeCharacterIndex,
        skillIndex: index,
        skillName: name,
        cost: options.paidByCard ? 0 : ctx.cost,
    });
    engine.trigger(playerIndex, "use_skill", ctx);
    engine.definition(playerIndex, skill, ctx);
    if (!burst) actor.energy = Math.min(actor.maxEnergy, actor.energy + ctx.energyGain);
    if (actor.preparedSkill === name) {
        delete actor.preparedSkill;
        for (const state of [...owner.states])
            if (state.name === name + " (preparing)") engine.remove(playerIndex, state);
    }
    engine.trigger(playerIndex, "after_attack", ctx);
    engine.trigger(1 - playerIndex, "after_attack", {
        ...ctx,
        playerIndex: 1 - playerIndex,
        actorIndex: match.players[1 - playerIndex].activeCharacterIndex,
        opponentEvent: true,
    });
    engine.trigger(playerIndex, "extra_attack", ctx);
    engine.trigger(playerIndex, "action", ctx);
    return {};
}

export function resolveSkill(match, playerIndex, command) {
    return transaction(match, (trial, engine) => skillAction(trial, playerIndex, command, engine));
}

export function cardTargetType(card) {
    const fetches = [...list(card.fetch), ...list(card.modify).flatMap(m => list(m.fetch))];
    if (fetches.some(f => f.type === "oppose_summon")) return "OpponentSummon";
    if (fetches.some(f => f.type === "summon")) return "Summon";
    if (fetches.some(f => f.export === "__from")) return "CharacterPair";
    if (fetches.some(f => f.type === "character")) return "Character";
    return "None";
}
export function resolveCard(match, playerIndex, command) {
    return transaction(match, (trial, engine) => {
        const owner = trial.players[playerIndex],
            index = Number(command.handIndex);
        if (!Number.isInteger(index) || index < 0 || index >= owner.hand.length)
            return error("InvalidAction", "Card index is invalid");
        const found = findEntry(cards, owner.hand[index]);
        if (!found) return error("UnknownCard", `Card data not found: ${owner.hand[index]}`);
        const [name, card] = found,
            actor = owner.characters[owner.activeCharacterIndex];
        if (!actor || actor.hp <= 0) return error("DefeatedCharacter", "Choose a living active character first");
        const targetType = cardTargetType(card);
        const target = { playerIndex, zone: "Character", index: owner.activeCharacterIndex, ...(command.target || {}) };
        if (targetType.includes("Summon")) {
            const pi = targetType === "OpponentSummon" ? 1 - playerIndex : playerIndex;
            if (
                target.zone !== "Summon" ||
                target.playerIndex !== pi ||
                !Number.isInteger(target.index) ||
                !trial.players[pi].summons[target.index]
            )
                return error("SelectSummon", "Select a valid summon for this card");
        } else if (
            target.playerIndex !== playerIndex ||
            target.zone !== "Character" ||
            !Number.isInteger(target.index) ||
            !owner.characters[target.index] ||
            owner.characters[target.index].hp <= 0
        ) {
            return error("InvalidTarget", "Select one of your living characters");
        }
        const ctx = engine.context(playerIndex, {
            cardName: name,
            definition: card,
            target,
            cost: pointCost(card.cost),
        });
        engine.fetch(card.fetch, ctx);
        for (const mod of list(card.modify)) {
            engine.fetch(mod.fetch, ctx);
            engine.fetch(mod.get, ctx);
        }
        if (targetType === "CharacterPair") {
            const slot = JSON.stringify(card.modify).includes("EXCHANGE_WEAPON") ? "Weapon" : "Artifact";
            if (
                !Number.isInteger(target.fromIndex) ||
                target.fromIndex === target.index ||
                !owner.characters[target.fromIndex] ||
                owner.characters[target.fromIndex].hp <= 0 ||
                !owner.states.some(s => s.equipmentSlot === slot && s.characterIndex === target.fromIndex)
            )
                return error("SelectCharacters", "Select a character with equipment, then its recipient");
        }
        const weapon = list(card.tag).find(t => ["SWORD", "CLAYMORE", "POLEARM", "BOW", "CATALYST"].includes(t));
        if (
            weapon &&
            !sameWeapon(weapon, findEntry(characters, owner.characters[target.index].characterId)?.[1]?.weapon)
        )
            return error("WeaponMismatch", "This weapon does not match the selected character");
        if (!list(card.combat_limit).every(condition => engine.condition(condition, ctx)))
            return error("CardRequirement", "The card's play requirements are not met");
        engine.trigger(playerIndex, "card_cost", ctx);
        engine.trigger(playerIndex, "cost", ctx);
        const energy = Number(card.cost?.ENERGY || 0);
        if (ctx.cost > owner.elementPoints) return error("InsufficientElementPoints", "Not enough element points");
        if (energy > actor.energy) return error("InsufficientEnergy", "Not enough Energy");
        owner.elementPoints -= ctx.cost;
        actor.energy -= energy;
        owner.hand.splice(index, 1);
        actor.energy = Math.min(actor.maxEnergy, actor.energy + Number(card.energy || 0));
        engine.events.push({ eventType: "CardPlayed", playerIndex, handIndex: index, cardName: name, cost: ctx.cost });
        engine.definition(playerIndex, card, ctx);
        engine.trigger(playerIndex, "play_card", ctx);
        if (card.use_skill) {
            const skillIndex = Object.keys(findEntry(characters, actor.characterId)?.[1]?.skills || {}).indexOf(
                card.use_skill,
            );
            if (skillIndex < 0)
                return error("InvalidTalentCharacter", "This card requires its matching active character");
            const result = skillAction(trial, playerIndex, { skillIndex }, engine, { paidByCard: true });
            if (result.error) return result;
        }
        engine.trigger(playerIndex, "action", ctx);
        return {};
    });
}

export function resolveSwitch(match, playerIndex, index) {
    return transaction(match, (trial, engine) => {
        const player = trial.players[playerIndex];
        const ctx = engine.context(playerIndex, { cost: 0, target: { zone: "Character", playerIndex, index } });
        engine.trigger(playerIndex, "change_from", ctx);
        player.activeCharacterIndex = index;

        for (const character of player.characters) delete character.preparedSkill;
        for (const state of [...player.states]) if (state.icon === "prepare") engine.remove(playerIndex, state);
        engine.trigger(playerIndex, "change_to", { actorIndex: index });
        engine.trigger(playerIndex, "after_change", { actorIndex: index });
        return { fastSwitch: ctx.fastSwitch || false };
    });
}
export function initializeEffects(match) {
    const engine = new EffectEngine(match);
    match.players.forEach((player, playerIndex) => {
        player.characters.forEach((character, actorIndex) => {
            const profile = findEntry(characters, character.characterId)?.[1];
            for (const [name, skill] of Object.entries(profile?.skills || {})) {
                if (!list(skill.type).includes("Passive Skill")) continue;
                const ctx = engine.context(playerIndex, { actorIndex, skillName: name, definition: skill });
                engine.add(playerIndex, name, "state", ctx, { store: "SELF", modify: skill.modify, passive: true });
                for (const state of Object.keys(skill.create || {})) engine.add(playerIndex, state, "state", ctx);
            }
        });
    });
    return engine.events;
}
export function resolveRoundEnd(match) {
    const engine = new EffectEngine(match);
    engine.endRound();
    return engine.events;
}
export function resolveRoundStart(match) {
    const engine = new EffectEngine(match);
    engine.startRound();
    return engine.events;
}

export function availability(player, match) {
    const actor = player.characters[player.activeCharacterIndex],
        char = findEntry(characters, actor?.characterId);
    return Object.entries(char?.[1]?.skills || {}).map(([name, s], skillIndex) => {
        const maxUse = skillMaxUse(s),
            used = actor.skillUses?.[name] || 0;
        let cost = pointCost(s.cost);
        if (match) {
            const trial = { ...match, players: structuredClone(match.players) };
            const engine = new EffectEngine(trial),
                pi = match.players.indexOf(player);
            const ctx = engine.context(pi, { skillName: name, definition: s, cost });
            ctx.costOnly = true;
            engine.trigger(pi, "use_skill", ctx);
            delete ctx.costOnly;
            engine.trigger(pi, "before_skill_cost", ctx);
            engine.trigger(pi, "skill_cost", ctx);
            engine.trigger(pi, "cost", ctx);
            cost = ctx.cost;
        }
        const passive = list(s.type).includes("Passive Skill");
        const frozen = player.states.some(
            state => state.name === "Frozen" && state.characterIndex === player.activeCharacterIndex,
        );
        return {
            name,
            skillIndex,
            elementPointCost: cost,
            energyCost: Number(s.cost?.ENERGY || 0),
            isUltimate: list(s.type).includes("Elemental Burst"),
            maxUse,
            used,
            remainingUses: Math.max(0, maxUse - used),
            passive,
            unavailableReason: passive
                ? "Passive skills activate automatically"
                : frozen
                  ? "This character is Frozen until round end"
                  : match?.attackDisabled
                    ? "Sandstorm prevents attacks this round"
                    : used >= maxUse
                      ? "Skill use limit reached for this round"
                      : actor.preparedSkill && actor.preparedSkill !== name
                        ? `Use the prepared skill: ${actor.preparedSkill}`
                        : "",
            available:
                !passive &&
                !frozen &&
                !match?.attackDisabled &&
                (!actor.preparedSkill || actor.preparedSkill === name) &&
                cost <= player.elementPoints &&
                Number(s.cost?.ENERGY || 0) <= actor.energy &&
                actor.hp > 0 &&
                used < maxUse,
        };
    });
}

export function handAvailability(player, match) {
    const playerIndex = match.players.indexOf(player);
    return player.hand.map((cardId, handIndex) => {
        const card = findEntry(cards, cardId)?.[1] || {};
        const trial = { ...match, players: structuredClone(match.players) },
            engine = new EffectEngine(trial);
        const ctx = engine.context(playerIndex, { cardName: cardId, definition: card, cost: pointCost(card.cost) });
        engine.trigger(playerIndex, "card_cost", ctx);
        engine.trigger(playerIndex, "cost", ctx);
        const energyCost = Number(card.cost?.ENERGY || 0);
        return {
            handIndex,
            elementPointCost: ctx.cost,
            energyCost,
            targetType: cardTargetType(card),
            affordable:
                ctx.cost <= player.elementPoints && energyCost <= player.characters[player.activeCharacterIndex].energy,
        };
    });
}
