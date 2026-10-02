import { cards, characters, findEntry, normalizeId, pointCost, states, summons } from "./gameData.js";

export const list = value => (Array.isArray(value) ? value : value ? [value] : []);
const copy = value => structuredClone(value);
const same = (a, b) => normalizeId(a) === normalizeId(b);
const auraElements = new Set(["CRYO", "HYDRO", "PYRO", "ELECTRO", "DENDRO"]);
const reactions = {
    "CRYO+HYDRO": ["Frozen", 1],
    "ELECTRO+PYRO": ["Overloaded", 2],
    "HYDRO+PYRO": ["Vaporize", 2],
    "CRYO+PYRO": ["Melt", 2],
    "ELECTRO+HYDRO": ["Electro-Charged", 1],
    "DENDRO+ELECTRO": ["Quicken", 1],
    "DENDRO+HYDRO": ["Bloom", 1],
    "DENDRO+PYRO": ["Burning", 1],
    "CRYO+ELECTRO": ["Superconduct", 1],
};
const specialCounters = new Set([
    "Frostflake Arrow",
    "Searing Onslaught",
    "Indwelling",
    "Radical Vitality",
    "ZEAL",
    "Transmutation Materials",
    "Forging Billet",
    "Pigeon",
    "Element Dice",
    "Inspiration",
    "Qualitative Progress",
]);

export function publicEffect(item) {
    return {
        name: item.name,
        kind: item.kind,
        icon: item.icon || "",
        description: item.description || "",
        usage: item.usage ?? null,
        shield: item.shield || 0,
        remainingRounds: (item.modifiers || []).some(m => m.roundsLeft != null)
            ? Math.max(...item.modifiers.filter(m => m.roundsLeft != null).map(m => m.roundsLeft))
            : null,
        characterIndex: item.characterIndex ?? null,
        counters: item.counters || {},
    };
}

function modifiers(definition) {
    return list(definition.modify).map((mod, index) => ({
        ...copy(mod),
        name: mod.name || `Effect ${index}`,
        usesLeft: mod.time_limit?.USAGE ?? mod.time_limit?.usage ?? null,
        roundsLeft: mod.time_limit?.DURATION ?? null,
        roundUsesLeft: mod.time_limit?.ROUND?.[0] ?? null,
    }));
}
function iconFor(definition) {
    if (definition.icon) return definition.icon;
    const text = JSON.stringify(definition.modify || []);
    if (text.includes("SHIELD")) return "shield";
    if (text.includes("HURT")) return "sub_hurt";
    if (text.includes("HEAL")) return "heal";
    if (text.includes("COST")) return "change_cost_add";
    return "state";
}

export class EffectEngine {
    constructor(match, events = []) {
        this.match = match;
        this.events = events;
        this.depth = 0;
        this.executing = new Set();
    }
    owner(index) {
        return this.match.players[index];
    }
    actor(index, characterIndex) {
        const p = this.owner(index);
        return p.characters[characterIndex ?? p.activeCharacterIndex];
    }
    zones(index) {
        return [...(this.owner(index).states || []), ...(this.owner(index).summons || [])];
    }
    context(index, extra = {}) {
        return { playerIndex: index, actorIndex: this.owner(index).activeCharacterIndex, vars: {}, tags: [], ...extra };
    }
    value(value, ctx, item) {
        if (typeof value !== "string") return value;
        const direct = /^\{([^}]+)\}$/.exec(value);
        if (direct) return ctx.vars?.[direct[1]] ?? item?.vars?.[direct[1]] ?? 0;
        const replaced = value.replace(/\{([^}]+)\}/g, (_, key) => {
            const v = ctx.vars?.[key] ?? item?.vars?.[key];
            return v === undefined ? 0 : typeof v === "object" ? v.name || v.characterId || "" : v;
        });
        return /^[-+]?\d+(\.\d+)?$/.test(replaced) ? Number(replaced) : replaced;
    }
    adjust(current, value, ctx, item) {
        const v = this.value(value, ctx, item);
        if (typeof v === "string" && /^[*/]/.test(v)) {
            const n = Number(v.slice(1));
            return v[0] === "*" ? current * n : n ? Math.ceil(current / n) : current;
        }
        return current + (Number(v) || 0);
    }
    counter(item, name, ctx) {
        const actor = this.actor(ctx.playerIndex, item?.characterIndex ?? ctx.actorIndex);
        for (const target of [item?.counters || {}, actor?.counters || {}]) {
            const key = Object.keys(target).find(key => same(key, name));
            if (key !== undefined) return target[key];
        }
        return 0;
    }
    fetch(records, ctx, item) {
        for (const record of list(records)) {
            const p = this.owner(ctx.playerIndex),
                actor = this.actor(ctx.playerIndex, ctx.actorIndex);
            let value;
            if (record.logic === "fetch") {
                value =
                    record.export === "__from"
                        ? (ctx.target?.fromIndex ?? ctx.actorIndex)
                        : (ctx.target?.index ?? ctx.actorIndex);
                if (record.type === "character") value = p.characters[value] || actor;
                if (["summon", "oppose_summon"].includes(record.type))
                    value = this.owner(ctx.target?.playerIndex ?? ctx.playerIndex).summons[ctx.target?.index || 0];
            } else if (record.logic === "sum") {
                if (record.what === "counter") value = this.counter(item, record.type, ctx);
                else if (record.what === "card") value = ctx.cost ?? pointCost(ctx.definition?.cost);
                else if (record.what === "nation")
                    value = p.characters.filter(c =>
                        list(findEntry(characters, c.characterId)?.[1]?.nation).includes("Liyue"),
                    ).length;
                else if (record.whose === "summon") value = p.summons.length;
                else if (record.what === "dice") value = Math.min(3, p.elementPoints);
            } else if (record.logic === "get") {
                if (record.what === "element")
                    value =
                        record.whose === "swirl"
                            ? ctx.reactionElements?.[0]
                            : record.where === "summon"
                              ? p.summons.find(x => same(x.name, record.whose))?.vars?.__element
                              : findEntry(characters, actor.characterId)?.[1]?.element_type || ctx.element || "OMNI";
                else if (["weapon", "artifact"].includes(record.what)) {
                    const selected = this.value(record.where, ctx, item);
                    const ci = p.characters.indexOf(selected);
                    value =
                        record.whose === "type"
                            ? record.what === "weapon"
                                ? findEntry(characters, selected?.characterId)?.[1]?.weapon
                                : "Artifact"
                            : p.states.find(
                                  s =>
                                      s.characterIndex === ci &&
                                      s.equipmentSlot === (record.what === "weapon" ? "Weapon" : "Artifact"),
                              )?.name;
                } else if (["summon", "state"].includes(record.what))
                    value = this.zones(ctx.playerIndex).find(x => same(x.name, record.whose));
                else if (record.what === "skill") value = ctx.skillName;
                else if (record.what === "counter") value = this.counter(item, record.whose, ctx);
                else value = actor[record.what];
            }
            if (record.export) ctx.vars[record.export] = value ?? 0;
        }
    }
    compare(a, op, b) {
        if (["equal", "is"].includes(op)) {
            if (b === "even") return Number(a) % 2 === 0;
            if (b === "melee") return ["sword", "claymore", "polearm"].includes(String(a).toLowerCase());
            return typeof a === "number" || typeof b === "number" ? Number(a) === Number(b) : same(a, b);
        }
        if (["not_equal", "is_not", "unequal"].includes(op)) return !this.compare(a, "equal", b);
        if (op === "large") return Number(a) > Number(b);
        if (op === "large_equal") return Number(a) >= Number(b);
        if (["less", "small"].includes(op)) return Number(a) < Number(b);
        if (op === "less_equal") return Number(a) <= Number(b);
        return false;
    }
    condition(condition, ctx, item) {
        if (Array.isArray(condition)) return condition.some(c => this.condition(c, ctx, item));
        const p = this.owner(ctx.playerIndex),
            actor = this.actor(ctx.playerIndex, ctx.actorIndex);
        if (typeof condition === "string") {
            const type = list(ctx.definition?.type);
            const flags = {
                NORMAL_ATTACK: type.includes("Normal Attack"),
                ELEMENTAL_SKILL: type.includes("Elemental Skill"),
                ELEMENTAL_BURST: type.includes("Elemental Burst"),
                SKILL: !!ctx.skillName,
                IS_ACTIVE: item?.characterIndex == null || item.characterIndex === p.activeCharacterIndex,
                STAGE_ROUND_END: ctx.trigger === "end",
                STAGE_ROUND_START: ctx.trigger === "start",
                STAGE_ROLL: ctx.trigger === "roll",
                STAGE_ACTION: !["start", "end", "duration", "roll"].includes(ctx.trigger),
                ELEMENT_REACTION: !!ctx.reaction,
                CHARGED_ATTACK: (ctx.tags || []).includes("CHARGED_ATTACK"),
                SWIRL: ctx.reaction === "Swirl",
                HYDRO_RELATED: (ctx.reactionElements || []).includes("HYDRO"),
                DENDRO_RELATED: (ctx.reactionElements || []).includes("DENDRO"),
                PYRO_RELATED: (ctx.reactionElements || []).includes("PYRO"),
                ELEMENT_DMG: !!ctx.element && ctx.element !== "PHYSICAL",
                ELEMENT_HURT: !!ctx.element && ctx.element !== "PHYSICAL",
                CHECK: true,
                EXCLUSIVE: !ctx.exclusiveUsed,
                MINUS: ctx.hpDelta !== undefined ? ctx.hpDelta < 0 : Number(ctx.cost) > 0,
                SHIELD: this.zones(ctx.playerIndex).some(x => x.shield > 0),
            };
            if (condition in flags) return flags[condition];
            if (condition.startsWith("ELEMENT_ALL_"))
                return p.characters.some(c =>
                    same(findEntry(characters, c.characterId)?.[1]?.element_type, condition.slice(12)),
                );
            return (
                same(ctx.skillName, condition) ||
                same(ctx.subject?.name, condition) ||
                same(ctx.modifierName, condition) ||
                this.zones(ctx.playerIndex).some(x => same(x.name, condition))
            );
        }
        if (!condition || typeof condition !== "object") return true;
        if (!condition.logic && condition.condition)
            return list(condition.condition).every(c => this.condition(c, ctx, item));
        if (["get", "sum", "fetch"].includes(condition.logic)) {
            this.fetch(condition, ctx, item);
            return true;
        }
        if (["is_active", "is_alive"].includes(condition.logic))
            return p.characters.some(
                (c, i) =>
                    same(c.characterId, condition.who) &&
                    c.hp > 0 &&
                    (condition.logic !== "is_active" || i === p.activeCharacterIndex),
            );
        if (condition.logic === "play_card") return list(ctx.definition?.tag).includes(condition.tag);
        if (condition.logic === "compare")
            return this.compare(
                this.value(condition.value1, ctx, item),
                condition.operator,
                this.value(condition.value2, ctx, item),
            );
        if (condition.logic === "have") {
            const zoneIndex = condition.where === "oppose" ? 1 - ctx.playerIndex : ctx.playerIndex;
            let found;
            if (condition.what === "event") found = !!ctx.defeated;
            else if (condition.what === "card")
                found = this.owner(zoneIndex).hand.some(id => same(id, condition.condition));
            else if (condition.what === "modify")
                found = (item?.modifiers || []).some(m => same(m.name, condition.condition) && m.usesLeft !== 0);
            else found = this.zones(zoneIndex).some(x => same(x.name, condition.condition));
            return ["not_equal", "is_not"].includes(condition.operator) ? !found : found;
        }
        if (condition.logic === "check") {
            const who = condition.whose;
            let selected =
                who === "oppose" ? this.actor(1 - ctx.playerIndex) : who === "{__select}" ? ctx.vars.__select : actor;
            if (!selected || typeof selected !== "object") selected = actor;
            let actual;
            if (condition.what === "counter") actual = this.counter(item, who, ctx);
            else if (condition.what === "skill") actual = ctx.skillName;
            else if (condition.what === "name") actual = selected.characterId;
            else if (condition.what === "weapon") actual = findEntry(characters, selected.characterId)?.[1]?.weapon;
            else if (condition.what === "hurt") actual = ctx.damage;
            else if (condition.what === "dice") actual = p.elementPoints;
            else if (condition.what === "element")
                actual = ["attack", "hurt"].includes(who)
                    ? ctx.element
                    : String(who).includes("__")
                      ? this.value(who, ctx, item)
                      : who === "self" && item?.vars?.__element
                        ? item.vars.__element
                        : findEntry(characters, selected.characterId)?.[1]?.element_type;
            else actual = selected[condition.what];
            const expected =
                condition.condition === "full" && condition.what === "energy"
                    ? selected.maxEnergy
                    : this.value(condition.condition, ctx, item);
            return this.compare(actual, condition.operator, expected);
        }
        return false;
    }
    matches(mod, ctx, item) {
        return list(mod.condition).every(c => this.condition(c, ctx, item));
    }
    targets(index, target, ctx, item) {
        const enemy = String(target).startsWith("OPPOSE");
        const pi = enemy ? 1 - index : index,
            p = this.owner(pi);
        if (["ALL", "TEAM", "OPPOSE_ALL", "_each"].includes(target)) return p.characters.map((c, i) => [pi, i]);
        if (target === "STANDBY")
            return p.characters.flatMap((c, i) => (i !== p.activeCharacterIndex ? [[pi, i]] : []));
        if (target === "ACTIVE_FIRST") {
            const i =
                p.characters[p.activeCharacterIndex].hp < p.characters[p.activeCharacterIndex].maxHp
                    ? p.activeCharacterIndex
                    : p.characters.findIndex(c => c.hp > 0 && c.hp < c.maxHp);
            return i < 0 ? [] : [[pi, i]];
        }
        const i =
            target === "SELF"
                ? (item?.characterIndex ?? ctx.actorIndex)
                : target === "{__select}"
                  ? (ctx.target?.index ?? ctx.actorIndex)
                  : p.activeCharacterIndex;
        return [[pi, i]];
    }
    add(index, name, kind, ctx = this.context(index), supplied) {
        const database = kind === "summon" ? summons : states;
        const found = findEntry(database, name);
        let definition = supplied || found?.[1] || {};
        let resolvedName = found?.[0] || name;
        const variants = Object.entries(definition.type || {});
        if (variants.length) {
            const unused = variants.filter(([n]) => !this.owner(index).summons.some(x => x.name === n));
            const pool = unused.length ? unused : variants;
            [resolvedName, definition] = pool[Math.floor(Math.random() * pool.length)];
        }
        const opposing = String(definition.store).startsWith("OPPOSE");
        const pi = opposing ? 1 - index : index;
        const characterIndex = ["SELF", "{__select}", "OPPOSE_SELF"].includes(definition.store)
            ? opposing
                ? this.owner(pi).activeCharacterIndex
                : ctx.target?.zone === "Character"
                  ? ctx.target.index
                  : ctx.actorIndex
            : null;
        const item = {
            name: resolvedName,
            kind,
            icon: iconFor(definition),
            description: definition.description || "",
            characterIndex,
            usage: definition.usage ?? null,
            modifiers: modifiers(definition),
            counters: {},
            vars: copy(definition.special_const || {}),
            sourceCard: definition.sourceCard || null,
            passive: definition.passive || false,
        };
        this.fetch(definition.get || definition.fetch, ctx, item);
        const zone = kind === "summon" ? this.owner(pi).summons : this.owner(pi).states;
        // Reapplying refreshes a status instead of duplicating its callbacks.
        const existing = zone.findIndex(x => same(x.name, resolvedName) && x.characterIndex === characterIndex);
        if (existing >= 0) zone.splice(existing, 1);
        zone.push(item);
        this.events.push({
            eventType: kind === "summon" ? "SummonAdded" : "StateAdded",
            playerIndex: pi,
            name: resolvedName,
            usage: item.usage,
        });
        this.trigger(index, kind === "summon" ? "add_summon" : "add_state", { ...ctx, subject: item });
        for (const mod of item.modifiers) {
            if (
                mod.immediate ||
                mod.time_limit?.IMMEDIATE ||
                (["use_skill", "play_card"].includes(ctx.trigger) &&
                    mod.trigger_time === ctx.trigger &&
                    JSON.stringify(mod.effect).includes("SHIELD"))
            )
                this.run(pi, mod, item, { ...ctx, playerIndex: pi, subject: item });
        }
        return item;
    }
    remove(index, item) {
        const p = this.owner(index),
            zone = item.kind === "summon" ? p.summons : p.states;
        const i = zone.indexOf(item);
        if (i < 0) return;
        zone.splice(i, 1);
        this.events.push({ eventType: "EffectRemoved", playerIndex: index, name: item.name });
        this.trigger(index, "remove_state", { subject: item });
    }
    run(index, mod, item, ctx) {
        if (this.executing.has(mod) || mod.usesLeft === 0 || mod.roundsLeft === 0 || mod.roundUsesLeft === 0)
            return false;
        this.fetch(mod.fetch, ctx, item);
        this.fetch(mod.get, ctx, item);
        if (!this.matches(mod, ctx, item)) return false;
        if (item?.characterIndex != null && this.actor(index, item.characterIndex)?.hp <= 0) return false;
        this.executing.add(mod);
        if (ctx.trigger !== "invoke_modify")
            this.trigger(index, "invoke_modify", { ...ctx, subject: item, modifierName: mod.name });
        try {
            this.execute(index, mod.effect || {}, mod.effect_obj || "SELF", ctx, item);
        } finally {
            this.executing.delete(mod);
        }
        if (list(mod.condition).includes("EXCLUSIVE")) ctx.exclusiveUsed = true;
        if (mod.usesLeft != null) --mod.usesLeft;
        if (mod.roundUsesLeft != null) --mod.roundUsesLeft;
        if (mod.immediate || mod.time_limit?.IMMEDIATE) mod.usesLeft = 0;
        if (item && mod.consume && ctx.consume !== false)
            item.usage = mod.consume === "ALL" ? 0 : Math.max(0, (item.usage ?? 1) - Number(mod.consume));
        return true;
    }
    trigger(index, trigger, extra = {}) {
        if (this.depth >= 32) throw new Error("Effect trigger recursion exceeded");
        ++this.depth;
        const ctx = this.context(index, extra);
        ctx.trigger = trigger;
        for (const item of this.zones(index)) {
            if (!this.zones(index).includes(item)) continue;
            if (
                item.characterIndex != null &&
                item.characterIndex !== (ctx.targetCharacterIndex ?? ctx.actorIndex) &&
                !["start", "end", "duration", "roll", "any", "add_state", "add_summon"].includes(trigger)
            )
                continue;
            if (
                !["invoke_state", "invoke_modify"].includes(trigger) &&
                (item.modifiers || []).some(m => m.trigger_time === trigger)
            )
                this.trigger(index, "invoke_state", { ...ctx, subject: item });
            for (const mod of item.modifiers || []) {
                if (ctx.opponentEvent && !["OPPOSE", "ALL"].includes(mod.from)) continue;
                if (!ctx.opponentEvent && mod.from === "OPPOSE" && !["defense", "pierce_hurt"].includes(trigger))
                    continue;
                if (mod.immediate || mod.time_limit?.IMMEDIATE) continue;
                const costEffect = /"(?:COST_[A-Z]+|CHANGE_COST)"/.test(JSON.stringify(mod.effect || {}));
                if ((ctx.costOnly && !costEffect) || (trigger === "use_skill" && !ctx.costOnly && costEffect)) continue;
                if (mod.trigger_time === trigger || mod.trigger_time === "any") this.run(index, mod, item, ctx);
            }
            if (
                item.usage === 0 ||
                ((item.modifiers || []).length && item.modifiers.every(m => m.usesLeft === 0 || m.roundsLeft === 0))
            )
                this.remove(index, item);
        }
        --this.depth;
        Object.assign(extra, ctx);
        return ctx;
    }
    execute(index, effect, target, ctx, item) {
        if (!effect.effect_type) {
            for (const [type, value] of Object.entries(effect))
                this.execute(index, { effect_type: type, effect_value: value }, target, ctx, item);
            return;
        }
        const type = this.value(effect.effect_type, ctx, item),
            raw = effect.effect_value,
            value = this.value(raw, ctx, item);
        if (type && typeof type === "object") {
            for (const [element, amount] of Object.entries(type))
                this.execute(index, { effect_type: element + "_DMG", effect_value: amount }, target, ctx, item);
            return;
        }
        const p = this.owner(index),
            actor = this.actor(index, ctx.actorIndex);
        const selected = this.targets(index, target, ctx, item);
        if (type.endsWith("_DMG")) {
            for (const [pi, ci] of selected)
                this.damage(index, pi, ci, type.slice(0, -4), Number(value) || 0, { ...ctx, secondary: true });
        } else if (type === "HEAL") {
            for (const [pi, ci] of selected) {
                const c = this.actor(pi, ci);
                if (!c || c.hp <= 0) continue;
                const old = c.hp;
                c.hp = Math.max(0, Math.min(c.maxHp, c.hp + Number(value || 0)));
                this.events.push({ eventType: "Healed", playerIndex: pi, characterIndex: ci, amount: c.hp - old });
                this.trigger(pi, "change_hp", { actorIndex: ci, hpDelta: c.hp - old });
            }
        } else if (type === "HURT") ctx.damage = Math.max(0, this.adjust(ctx.damage || 0, raw, ctx, item));
        else if (type === "DMG") ctx.damage = this.adjust(ctx.damage || 0, raw, ctx, item);
        else if (type === "CHANGE_SKILL_DAMAGE") ctx.damageOverride = copy(raw);
        else if (type === "SHIELD") {
            const shield = Number(this.value(raw.shield, ctx, item)) || 0;
            if (shield <= 0) return;
            const status = this.add(index, raw.name || "Shield", "state", ctx, {
                store: target === "SELF" ? "SELF" : "TEAM",
                icon: "shield",
            });
            status.shield = shield;
            status.usage = shield;
        } else if (type === "INFUSION") {
            ctx.infusion = String(raw.type || raw).toUpperCase();
            if (raw.time_limit) {
                const status = this.add(index, raw.name || "Infusion", "state", ctx, {
                    store: "SELF",
                    icon: ctx.infusion.toLowerCase() + "_infusion",
                    modify: [
                        {
                            trigger_time: "use_skill",
                            effect: { effect_type: "INFUSION", effect_value: { type: ctx.infusion } },
                            time_limit: raw.time_limit,
                        },
                    ],
                });
                status.infusion = ctx.infusion;
            }
        } else if (type === "APPLICATION") {
            for (const [pi, ci] of selected) this.applyAura(index, pi, ci, String(value).toUpperCase(), ctx);
        } else if (type === "ADD_STATE") {
            for (const [name] of Object.entries(raw || {})) this.add(index, name, "state", ctx);
        } else if (type === "DRAW_CARD") p.hand.push(...p.deck.splice(0, Math.max(0, Number(value) || 0)));
        else if (["CHANGE_ENERGY", "SET_ENERGY"].includes(type)) {
            for (const [pi, ci] of selected) {
                const c = this.actor(pi, ci);
                if (c?.hp > 0)
                    c.energy = Math.max(
                        0,
                        Math.min(c.maxEnergy, type === "SET_ENERGY" ? Number(value) : c.energy + Number(value)),
                    );
            }
        } else if (type === "SKILL_ADD_ENERGY") ctx.energyGain = Number(value);
        else if (type.startsWith("COST_") || type === "CHANGE_COST") {
            const element = type.slice(5);
            if (
                !type.startsWith("COST_") ||
                ["ALL", "ELEMENT", "ANY"].includes(element) ||
                ctx.definition?.cost?.[element]
            )
                ctx.cost = Math.max(0, this.adjust(ctx.cost || 0, raw, ctx, item));
        } else if (type === "APPEND_DICE") {
            const count = Array.isArray(raw) ? raw.length : typeof value === "number" ? value : 1;
            p.elementPoints = Math.max(0, p.elementPoints + count);
        } else if (type === "FIXED_DICE" || type === "REROLL") {
            // Every point is already Omni in this server. Fixing or rerolling its
            // element changes neither the amount nor purchasing power of the EP pool.
            this.events.push({ eventType: "OmniPoolUnchanged", playerIndex: index, effect: type });
        } else if (type === "CHANGE_ACTION") ctx.fastSwitch = value === "fast";
        else if (["CHANGE_CHARACTER", "CHANGE_TO"].includes(type)) {
            const pi = String(target).startsWith("OPPOSE") ? 1 - index : index;
            const owner = this.owner(pi);
            if (owner.characters[owner.activeCharacterIndex].hp <= 0) return;
            let ci = type === "CHANGE_TO" ? owner.characters.findIndex(c => same(c.characterId, value)) : -1;
            if (type === "CHANGE_TO" && Number.isInteger(value)) ci = value;
            if (type === "CHANGE_CHARACTER") {
                for (let offset = 1; offset < owner.characters.length; ++offset) {
                    const next =
                        (owner.activeCharacterIndex + offset * (Number(value) < 0 ? -1 : 1) + owner.characters.length) %
                        owner.characters.length;
                    if (owner.characters[next].hp > 0) {
                        ci = next;
                        break;
                    }
                }
            }
            if (ci >= 0 && owner.characters[ci]?.hp > 0 && ci !== owner.activeCharacterIndex) {
                if (ctx.cardName && pi === index) {
                    if ((owner.switchesUsed || 0) >= 1)
                        throw new Error("You can only switch characters once per round");
                    owner.switchesUsed = (owner.switchesUsed || 0) + 1;
                }
                owner.activeCharacterIndex = ci;
                this.events.push({ eventType: "ActiveCharacterChanged", playerIndex: pi, characterIndex: ci });
                this.trigger(pi, "change_to", { actorIndex: ci });
            }
        } else if (type === "ADD_CARD") p.hand.push(String(value));
        else if (type === "USE_CARD") {
            const i = p.hand.findIndex(id => same(id, value));
            if (i >= 0) {
                const definition = findEntry(cards, p.hand.splice(i, 1)[0])?.[1];
                if (definition) this.definition(index, definition, { ...ctx, cardName: String(value) });
            }
        } else if (["EXCHANGE_WEAPON", "EXCHANGE_ARTIFACT"].includes(type)) {
            const slot = type === "EXCHANGE_WEAPON" ? "Weapon" : "Artifact";
            const from = ctx.target?.fromIndex,
                to = ctx.target?.index;
            const equipment = p.states.find(s => s.equipmentSlot === slot && s.characterIndex === from);
            if (equipment && Number.isInteger(to) && p.characters[to]?.hp > 0 && from !== to) {
                for (const old of [...p.states])
                    if (old.equipmentSlot === slot && old.characterIndex === to) this.remove(index, old);
                equipment.characterIndex = to;
                this.events.push({ eventType: "EquipmentMoved", playerIndex: index, name: equipment.name, from, to });
            }
        } else if (type === "EXCHANGE_ENERGY") {
            let transferred = 0;
            p.characters.forEach((c, i) => {
                if (i !== p.activeCharacterIndex && c.hp > 0 && c.energy > 0) {
                    c.energy--;
                    transferred++;
                }
            });
            actor.energy = Math.min(actor.maxEnergy, actor.energy + transferred);
        } else if (
            ["CHANGE_SUMMON_USAGE", "CONSUME_SUMMON_USAGE", "CHANGE_STATE_USAGE", "CHANGE_INIT_USAGE"].includes(type)
        ) {
            let items = type.includes("SUMMON") ? p.summons : p.states;
            if (ctx.subject && type === "CHANGE_INIT_USAGE") items = [ctx.subject];
            else if (ctx.target?.zone === "Summon")
                items = [this.owner(ctx.target.playerIndex ?? index).summons[ctx.target.index]].filter(Boolean);
            for (const zoneItem of items) {
                const change =
                    raw && typeof raw === "object"
                        ? Object.entries(raw).find(([name]) => same(name, zoneItem.name))?.[1]
                        : value;
                if (change === undefined) continue;
                zoneItem.usage =
                    type === "CHANGE_INIT_USAGE" || change === 0
                        ? Number(change)
                        : Math.max(
                              0,
                              (zoneItem.usage ?? 0) + (type === "CONSUME_SUMMON_USAGE" ? -1 : 1) * Number(change),
                          );
                if (zoneItem.usage === 0) this.remove(ctx.target?.playerIndex ?? index, zoneItem);
            }
        } else if (["ADD_COUNTER", "CLEAR_COUNTER", "CHANGE_COUNTER"].includes(type) || specialCounters.has(type)) {
            const holder =
                item?.kind === "summon" || item?.sourceCard
                    ? item
                    : this.actor(index, item?.characterIndex ?? ctx.actorIndex);
            holder.counters ||= {};
            const update = (name, v) => {
                const key = Object.keys(holder.counters).find(k => same(k, name)) || name;
                holder.counters[key] =
                    typeof v === "string" && /^[+-]/.test(v)
                        ? this.adjust(holder.counters[key] || 0, v, ctx, item)
                        : Number(this.value(v, ctx, item)) || 0;
            };
            if (type === "CLEAR_COUNTER") holder.counters = {};
            else if (type === "CHANGE_COUNTER") for (const [name, v] of Object.entries(raw)) update(name, v);
            else if (type === "ADD_COUNTER") update(String(value), "+1");
            else update(type, raw);
        } else if (type === "CHANGE_SPECIAL_CONST") {
            for (const [key, v] of Object.entries(raw)) (item ? item.vars : ctx.vars)[key] = this.value(v, ctx, item);
        } else if (type === "CHANGE_ELEMENT") {
            ctx.element = String(value).toUpperCase();
            if (item?.kind === "summon") item.vars.__element = ctx.element;
        } else if (type === "ADD_TAG") ctx.tags.push(String(value));
        else if (type === "PREPARE") {
            actor.preparedSkill = typeof raw === "string" ? raw : raw.name;
            this.add(index, actor.preparedSkill + " (preparing)", "state", ctx, { store: "SELF", icon: "prepare" });
        } else if (type === "TRIGGER") {
            for (const summon of [...p.summons]) {
                if (
                    String(raw.name).startsWith("TYPE_")
                        ? summon.name.includes(String(raw.name).slice(5))
                        : same(summon.name, raw.name)
                ) {
                    for (let i = 0; i < Number(raw.times || 1); ++i)
                        for (const mod of summon.modifiers || []) {
                            if (mod.trigger_time === "end")
                                this.run(index, mod, summon, { ...ctx, consume: raw.consume !== 0 });
                        }
                }
            }
        } else if (
            [
                "ADD_MODIFY",
                "CHANGE_MODIFY_EFFECT",
                "CHANGE_MODIFY_CONDITION",
                "CHANGE_STATE_EFFECT",
                "CHANGE_STATE_MODIFY",
            ].includes(type)
        ) {
            let destinations = ctx.subject?.modifiers ? [ctx.subject] : item?.modifiers ? [item] : [];
            if (!destinations.length && type === "ADD_MODIFY" && target !== "SKILL") {
                destinations = [
                    this.add(index, raw.name || "Granted effect", "state", ctx, { store: "SELF", modify: [] }),
                ];
            }
            if (ctx.vars.__object && typeof ctx.vars.__object === "object") destinations = [ctx.vars.__object];
            if (target === "SKILL") {
                ctx.extraModifiers ||= [];
                if (type === "ADD_MODIFY") ctx.extraModifiers.push(...modifiers({ modify: raw }));
                return;
            }
            for (const destination of destinations) {
                if (type === "ADD_MODIFY") {
                    const added = modifiers({ modify: raw });
                    destination.modifiers.push(...added);
                    for (const mod of added)
                        if (mod.immediate || mod.time_limit?.IMMEDIATE) this.run(index, mod, destination, ctx);
                } else if (type === "CHANGE_MODIFY_EFFECT") {
                    const m = destination.modifiers.find(m =>
                        same(m.name, ctx.modifierName || destination.name + "_0"),
                    );
                    if (m) m.effect = copy(raw);
                } else if (type === "CHANGE_MODIFY_CONDITION") {
                    for (const [name, condition] of Object.entries(raw)) {
                        const m = destination.modifiers.find(m => same(m.name, name));
                        if (m) m.condition = condition;
                    }
                } else if (type === "CHANGE_STATE_MODIFY") {
                    for (const [name, mods] of Object.entries(raw))
                        if (same(destination.name, name)) destination.modifiers.push(...modifiers({ modify: mods }));
                } else if (type === "CHANGE_STATE_EFFECT") {
                    for (const m of destination.modifiers) {
                        if (m.effect.effect_type === "INFUSION" && !raw.effect_type) {
                            m.effect.effect_value = { type: raw.type };
                            if (raw.time_limit?.DURATION != null) {
                                m.roundsLeft = raw.time_limit.DURATION;
                                m.time_limit = copy(raw.time_limit);
                            }
                        } else if (
                            raw.effect_type &&
                            (m.effect.effect_type === raw.effect_type || raw.effect_type in m.effect)
                        )
                            m.effect = copy(raw);
                    }
                }
            }
        } else {
            throw new Error(`Unsupported effect type: ${type}`);
        }
    }
    applyAura(sourceIndex, targetIndex, characterIndex, element, ctx) {
        const character = this.actor(targetIndex, characterIndex);
        if (!character || character.hp <= 0) return 0;
        const old = String(character.applications?.[0] || "").toUpperCase();
        if (this.match.reactionsDisabled) {
            if (auraElements.has(element) && !old) character.applications = [element];
            return 0;
        }
        let reaction = old && old !== element ? reactions[[old, element].sort().join("+")] : null;
        if (old && ["ANEMO", "GEO"].includes(element) && ["CRYO", "HYDRO", "PYRO", "ELECTRO"].includes(old))
            reaction = [element === "ANEMO" ? "Swirl" : "Crystallize", element === "ANEMO" ? 0 : 1];
        if (reaction) {
            character.applications = [];
            ctx.reaction = reaction[0];
            ctx.reactionElements = [old, element];
            this.events.push({
                eventType: "ElementalReaction",
                playerIndex: targetIndex,
                characterIndex,
                reaction: reaction[0],
                elements: [old, element],
                bonusDamage: reaction[1],
            });
            if (reaction[0] === "Frozen") this.add(sourceIndex, "Frozen", "state", ctx);
            if (reaction[0] === "Bloom") this.add(sourceIndex, "Dendro Core", "state", ctx);
            if (reaction[0] === "Quicken") this.add(sourceIndex, "Catalyzing Field", "state", ctx);
            if (reaction[0] === "Burning") this.add(sourceIndex, "Burning Flame", "summon", ctx);
            if (reaction[0] === "Crystallize")
                this.execute(
                    sourceIndex,
                    { effect_type: "SHIELD", effect_value: { name: "Crystallize", shield: 1 } },
                    "ACTIVE",
                    ctx,
                );
            this.trigger(sourceIndex, "element_reaction", ctx);
            if (["Swirl", "Superconduct", "Electro-Charged"].includes(reaction[0]) && !ctx.reactionSplash) {
                this.owner(targetIndex).characters.forEach((c, i) => {
                    if (i !== characterIndex)
                        this.damage(sourceIndex, targetIndex, i, reaction[0] === "Swirl" ? old : "PIERCE", 1, {
                            ...ctx,
                            reactionSplash: true,
                            secondary: true,
                        });
                });
            }
            return reaction[1];
        }
        if (auraElements.has(element) && !old) character.applications = [element];
        return 0;
    }
    damage(sourceIndex, targetIndex, characterIndex, element, amount, extra = {}) {
        const c = this.actor(targetIndex, characterIndex);
        if (!c || c.hp <= 0) return;
        let ctx = this.context(sourceIndex, { ...extra, damage: amount, element: String(element).toUpperCase() });
        if (ctx.element === "PHYSICAL" && ctx.infusion) ctx.element = ctx.infusion;
        if (!ctx.secondary && ctx.element !== "PIERCE") this.trigger(sourceIndex, "attack", ctx);
        ctx.damage += this.applyAura(sourceIndex, targetIndex, characterIndex, ctx.element, ctx);
        if (ctx.element === "PIERCE") {
            this.trigger(sourceIndex, "pierce", ctx);
            this.trigger(targetIndex, "pierce_hurt", { ...ctx, playerIndex: targetIndex, actorIndex: characterIndex });
        }
        if (ctx.element !== "PIERCE") {
            const frozen = this.owner(targetIndex).states.find(
                s => same(s.name, "Frozen") && s.characterIndex === characterIndex,
            );
            if (frozen && ["PHYSICAL", "PYRO"].includes(ctx.element)) {
                ctx.damage += 2;
                this.remove(targetIndex, frozen);
            }
            const defense = {
                ...ctx,
                playerIndex: targetIndex,
                actorIndex: characterIndex,
                targetCharacterIndex: characterIndex,
            };
            this.trigger(targetIndex, "defense", defense);
            ctx.damage = defense.damage;
            for (const shield of [...this.owner(targetIndex).states]) {
                if (!shield.shield || (shield.characterIndex != null && shield.characterIndex !== characterIndex))
                    continue;
                const absorbed = Math.min(shield.shield, ctx.damage);
                shield.shield -= absorbed;
                shield.usage = shield.shield;
                ctx.damage -= absorbed;
                if (!shield.shield) this.remove(targetIndex, shield);
            }
        }
        const dealt = Math.min(c.hp, Math.max(0, ctx.damage));
        c.hp -= dealt;
        this.events.push({
            eventType: "DamageDealt",
            playerIndex: targetIndex,
            characterIndex,
            element: ctx.element,
            amount: dealt,
        });
        this.trigger(targetIndex, "change_hp", { actorIndex: characterIndex, hpDelta: -dealt });
        if (c.hp === 0) {
            ctx.defeated = true;
            this.events.push({ eventType: "CharacterDefeated", playerIndex: targetIndex, characterIndex });
        }
        if (ctx.reaction === "Overloaded" && c.hp > 0)
            this.execute(sourceIndex, { effect_type: "CHANGE_CHARACTER", effect_value: 1 }, "OPPOSE", ctx);
        Object.assign(extra, {
            defeated: ctx.defeated,
            reaction: ctx.reaction,
            reactionElements: ctx.reactionElements,
        });
    }
    definition(index, definition, ctx) {
        const actor = this.actor(index, ctx.target?.zone === "Character" ? ctx.target.index : ctx.actorIndex);
        this.fetch(definition.fetch || definition.get, ctx);
        const mods = modifiers(definition);
        let sourceItem;
        // Register deferred skill records on the actor; play-card records are handled
        // at play time, while equipment/support/food callbacks stay in their zone.
        if (ctx.cardName) {
            const deferred = mods.filter(
                m => !m.immediate && !m.time_limit?.IMMEDIATE && m.trigger_time !== "play_card",
            );
            if (deferred.length) {
                const slot = list(definition.tag).find(t => ["Weapon", "Artifact", "Talent"].includes(t));
                if (slot)
                    for (const old of [...this.owner(index).states])
                        if (old.equipmentSlot === slot && old.characterIndex === (ctx.target?.index ?? ctx.actorIndex))
                            this.remove(index, old);
                const status = this.add(index, ctx.cardName, "state", ctx, {
                    ...definition,
                    modify: deferred,
                    sourceCard: ctx.cardName,
                });
                status.equipmentSlot = slot || null;
                sourceItem = status;
            }
        } else if (mods.some(m => !m.immediate && !m.time_limit?.IMMEDIATE)) {
            this.add(index, ctx.skillName, "state", ctx, {
                store: "SELF",
                modify: mods.filter(m => !m.immediate && !m.time_limit?.IMMEDIATE),
                icon: "state",
            });
        }
        const immediate = mods.filter(
            m => m.immediate || m.time_limit?.IMMEDIATE || (ctx.cardName && m.trigger_time === "play_card"),
        );
        for (const mod of immediate)
            if (!["after_attack", "extra_attack"].includes(mod.trigger_time))
                this.run(
                    index,
                    mod,
                    sourceItem || {
                        characterIndex: ctx.target?.zone === "Character" ? ctx.target.index : ctx.actorIndex,
                        counters: (actor.counters ||= {}),
                    },
                    ctx,
                );
        const damage = ctx.damageOverride || definition.damage || {};
        for (const [element, amount] of Object.entries(damage)) {
            if (element === "PIERCE")
                this.owner(1 - index).characters.forEach((c, ci) => {
                    if (ci !== this.owner(1 - index).activeCharacterIndex)
                        this.damage(index, 1 - index, ci, element, Number(amount), ctx);
                });
            else
                this.damage(index, 1 - index, this.owner(1 - index).activeCharacterIndex, element, Number(amount), ctx);
        }
        for (const [name, count] of Object.entries(definition.summon || {})) {
            const random = findEntry(summons, name)?.[1]?.type;
            for (let i = 0; i < (random ? Number(count) || 1 : 1); ++i) this.add(index, name, "summon", ctx);
        }
        for (const name of Object.keys(definition.create || {})) this.add(index, name, "state", ctx);
        for (const mod of immediate)
            if (["after_attack", "extra_attack"].includes(mod.trigger_time))
                this.run(
                    index,
                    mod,
                    sourceItem || {
                        characterIndex: ctx.target?.zone === "Character" ? ctx.target.index : ctx.actorIndex,
                        counters: (actor.counters ||= {}),
                    },
                    ctx,
                );
        for (const mod of ctx.extraModifiers || [])
            this.run(
                index,
                mod,
                sourceItem || {
                    characterIndex: ctx.target?.zone === "Character" ? ctx.target.index : ctx.actorIndex,
                    counters: (actor.counters ||= {}),
                },
                ctx,
            );
    }
    startRound() {
        for (let index = 0; index < this.match.players.length; ++index) {
            this.trigger(index, "roll");
            this.trigger(index, "start");
        }
    }
    endRound() {
        const order = [this.match.roundStarterIndex || 0, 1 - (this.match.roundStarterIndex || 0)];
        for (const index of order) {
            this.trigger(index, "end");
            if (this.match.players.some(player => player.characters.every(character => character.hp <= 0))) return;
        }
        for (const index of order) {
            this.trigger(index, "duration");
            for (const item of [...this.zones(index)]) {
                for (const mod of item.modifiers || []) {
                    if (mod.roundsLeft != null) --mod.roundsLeft;
                    if (mod.roundUsesLeft != null)
                        mod.roundUsesLeft = mod.time_limit.ROUND[1] ?? mod.time_limit.ROUND[0];
                }
                if (
                    same(item.name, "Frozen") ||
                    (item.modifiers?.length && item.modifiers.every(m => m.roundsLeft === 0 || m.usesLeft === 0))
                )
                    this.remove(index, item);
            }
        }
    }
}
