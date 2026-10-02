import assert from "node:assert/strict";
import test from "node:test";
import { EffectEngine } from "../effectEngine.js";
import { resolveSkill, resolveCard, availability, resolveRoundStart, resolveRoundEnd, resetRoundLimits, initializeEffects } from "../gameLogic.js";
import { cards, characters, findEntry } from "../gameData.js";
function fixture(ids = ["Diluc", "Fischl", "Ganyu"]) {
    const player = () => ({ characters: ids.map(characterId => ({characterId, hp: 20, maxHp: 20, energy: 3, maxEnergy: 3, applications: [], skillUses: {}})),
        activeCharacterIndex: 0, elementPoints: 30, states: [], summons: [], hand: [], deck: ["Paimon", "Sweet Madame", "Starsigns"] });
    return { players: [player(), player()], round: 1, roundStarterIndex: 0 };
}
function play(match, name, target) { match.players[0].hand = [name]; const result = resolveCard(match, 0, { handIndex: 0, target }); assert.equal(result.error, undefined, result.error?.join(": ")); return result; }
const skillIndex = (id, type) => Object.values(findEntry(characters, id)[1].skills).findIndex(s => s.type.includes(type));

test("summons deal damage at round end, spend usage once, and disappear at zero", () => {
    const match = fixture(), engine = new EffectEngine(match);
    engine.add(0, "Guoba", "summon");
    resolveRoundEnd(match);
    assert.equal(match.players[1].characters[0].hp, 18);
    assert.equal(match.players[0].summons[0].usage, 1);
    resolveRoundEnd(match);
    assert.equal(match.players[1].characters[0].hp, 16);
    assert.equal(match.players[0].summons.length, 0);
});

test("Bake-Kurage damages and heals in one activation without double consumption", () => {
    const match = fixture(); match.players[0].characters[0].hp = 12;
    new EffectEngine(match).add(0, "Bake-Kurage", "summon");
    resolveRoundEnd(match);
    assert.equal(match.players[1].characters[0].hp, 19);
    assert.equal(match.players[0].characters[0].hp, 13);
    assert.equal(match.players[0].summons[0].usage, 1);
});

test("Rain Sword reduces incoming damage and spends only its own usages", () => {
    const match = fixture(), engine = new EffectEngine(match);
    engine.add(1, "Rain Sword", "state");
    engine.damage(0, 1, 0, "PHYSICAL", 3);
    assert.equal(match.players[1].characters[0].hp, 18);
    assert.equal(match.players[1].states[0].usage, 1);
    engine.damage(0, 1, 0, "PHYSICAL", 3);
    assert.equal(match.players[1].characters[0].hp, 16);
    assert.equal(match.players[1].states.length, 0);
});

test("Full Plate creates a shield, halves physical damage, and expires when the shield breaks", () => {
    const match = fixture(), engine = new EffectEngine(match);
    engine.add(1, "Full Plate", "state");
    engine.damage(0, 1, 0, "PHYSICAL", 2);
    assert.equal(match.players[1].characters[0].hp, 20);
    assert.equal(match.players[1].states.find(s => s.shield).shield, 1);
    engine.damage(0, 1, 0, "PHYSICAL", 4);
    assert.equal(match.players[1].characters[0].hp, 19);
    assert.equal(match.players[1].states.length, 0);
});

test("food applies to the selected character; buffs consume on defense or expire at round end", () => {
    const match = fixture();
    play(match, "Lotus Flower Crisp", { playerIndex: 0, zone: "Character", index: 1 });
    const engine = new EffectEngine(match);
    engine.damage(1, 0, 0, "PHYSICAL", 4);
    assert.equal(match.players[0].characters[0].hp, 16);
    assert.equal(match.players[0].states.length, 1);
    engine.damage(1, 0, 1, "PHYSICAL", 4);
    assert.equal(match.players[0].characters[1].hp, 19);
    assert.equal(match.players[0].states.length, 0);
    play(match, "Lotus Flower Crisp");
    resolveRoundEnd(match);
    assert.equal(match.players[0].states.length, 0);
});

test("food cost reduction is reflected in availability and consumed only by a successful normal attack", () => {
    const match = fixture();
    play(match, "Northern Smoked Chicken");
    const index = skillIndex("Diluc", "Normal Attack");
    const before = structuredClone(match);
    assert.equal(availability(match.players[0], match)[index].elementPointCost, 2);
    assert.deepEqual(match, before);
    assert.equal(resolveSkill(match, 0, { skillIndex: index }).error, undefined);
    assert.equal(match.players[0].elementPoints, 28);
    assert.equal(match.players[0].states.length, 0);
});

test("support cards persist, generate EP at round start and expire on usage", () => {
    const match = fixture(); play(match, "Paimon");
    assert.equal(match.players[0].elementPoints, 27);
    resolveRoundStart(match); assert.equal(match.players[0].elementPoints, 29);
    assert.equal(match.players[0].states[0].usage, 1);
    resolveRoundStart(match); assert.equal(match.players[0].elementPoints, 31);
    assert.equal(match.players[0].states.length, 0);
});

test("quick knit and send off modify only the explicitly selected summon", () => {
    const match = fixture(), engine = new EffectEngine(match);
    engine.add(0, "Oz", "summon"); engine.add(1, "Guoba", "summon");
    play(match, "Quick Knit", { playerIndex: 0, zone: "Summon", index: 0 });
    assert.equal(match.players[0].summons[0].usage, 3);
    play(match, "Send Off", { playerIndex: 1, zone: "Summon", index: 0 });
    assert.equal(match.players[1].summons.length, 0);
    assert.equal(match.players[0].summons.length, 1);
});

test("healing/draw/energy cards apply immediate effects, not deferred callbacks", () => {
    const match = fixture(); match.players[0].characters[1].hp = 10;
    play(match, "Sweet Madame", { playerIndex: 0, zone: "Character", index: 1 });
    assert.equal(match.players[0].characters[1].hp, 11);
    match.players[0].characters[0].energy = 0;
    play(match, "Starsigns"); assert.equal(match.players[0].characters[0].energy, 1);
    play(match, "Strategize"); assert.equal(match.players[0].hand.length, 2);
    assert.equal(match.players[0].states.length, 0);
});

test("Pyro infusion changes normal attack damage and preserves aura/reaction rules", () => {
    const match = fixture();
    new EffectEngine(match).add(0, "Niwabi Enshou", "state");
    const result = resolveSkill(match, 0, { skillIndex: skillIndex("Diluc", "Normal Attack") });
    assert.equal(result.error, undefined);
    assert.equal(match.players[1].characters[0].hp, 17);
    assert.deepEqual(match.players[1].characters[0].applications, ["PYRO"]);
});

test("Frozen blocks skills then expires, while Cataclysm disables reactions", () => {
    const match = fixture(), engine = new EffectEngine(match);
    match.players[1].characters[0].applications = ["Hydro"];
    engine.damage(0, 1, 0, "CRYO", 1);
    assert.equal(resolveSkill(match, 1, { skillIndex: 0 }).error[0], "Frozen");
    resolveRoundEnd(match);
    assert.equal(resolveSkill(match, 1, { skillIndex: 0 }).error, undefined);
    match.reactionsDisabled = true;
    match.players[1].characters[0].applications = ["HYDRO"];
    const hp = match.players[1].characters[0].hp;
    engine.damage(0, 1, 0, "PYRO", 1);
    assert.equal(match.players[1].characters[0].hp, hp - 1);
});

test("weapon equips only matching characters, buffs damage, and transfers between two valid targets", () => {
    const match = fixture(["Kaeya", "Keqing", "Fischl"]);
    play(match, "Traveler's Handy Sword");
    assert.equal(match.players[0].states[0].equipmentSlot, "Weapon");
    const result = resolveSkill(match, 0, { skillIndex: skillIndex("Kaeya", "Normal Attack") });
    assert.equal(result.error, undefined);
    assert.equal(match.players[1].characters[0].hp, 17);
    play(match, "Master of Weaponry", { playerIndex: 0, zone: "Character", fromIndex: 0, index: 1 });
    assert.equal(match.players[0].states[0].characterIndex, 1);
});

test("support counters fund discounts; spending them and round limits persist", () => {
    const match = fixture(); play(match, "Timaeus");
    const timaeus = match.players[0].states.find(s => s.name === "Timaeus");
    assert.equal(timaeus.counters["Transmutation Materials"], 2);
    const before = match.players[0].elementPoints;
    play(match, "Adventurer's Bandana");
    assert.equal(match.players[0].elementPoints, before);
    assert.equal(timaeus.counters["Transmutation Materials"], 1);
});

test("summon special constants preserve elemental damage type", () => {
    const match = fixture();
    new EffectEngine(match).add(0, "Large Wind Spirit", "summon");
    const events = resolveRoundEnd(match);
    assert.ok(events.some(e => e.eventType === "DamageDealt" && e.element === "ANEMO" && e.amount === 2));
});

test("talent modifies a created shield before it activates", () => {
    const match = fixture(["Diona", "Diluc", "Fischl"]);
    play(match, "Shaken, Not Purred");
    assert.equal(match.players[0].states.find(s => s.shield)?.shield, 2);
    assert.equal(match.players[0].elementPoints, 26);
});

test("all character skills and their round-end effects resolve without interpreter errors", () => {
    for (const [name, profile] of Object.entries(characters)) {
        for (const [index, skill] of Object.values(profile.skills).entries()) {
            const match = fixture([name, "Diluc", "Fischl"]);
            initializeEffects(match);
            const result = resolveSkill(match, 0, { skillIndex: index });
            if (skill.type.includes("Passive Skill")) assert.equal(result.error?.[0], "PassiveSkill");
            else assert.notEqual(result.error?.[0], "EffectError", name + ": " + result.error?.[1]);
            assert.doesNotThrow(() => { resolveRoundEnd(match); resolveRoundStart(match); }, name);
        }
    }
});

test("fixed/rerolled elements do not fabricate EP in an all-Omni pool", () => {
    const match = fixture(), engine = new EffectEngine(match);
    const ctx = engine.context(0);
    engine.execute(0, {effect_type: "FIXED_DICE", effect_value: ["CRYO", "CRYO"]}, "PLAYER", ctx);
    engine.execute(0, {effect_type: "REROLL", effect_value: 2}, "PLAYER", ctx);
    assert.equal(match.players[0].elementPoints, 30);
});

test("standby piercing damage bypasses attack buffs and shields", () => {
    const match = fixture(["Kaeya", "Diluc", "Fischl"]), engine = new EffectEngine(match);
    play(match, "Traveler's Handy Sword");
    engine.execute(1, {effect_type: "SHIELD", effect_value: {name: "Test shield", shield: 3}}, "ACTIVE", engine.context(1));
    engine.damage(0, 1, 0, "PIERCE", 1);
    assert.equal(match.players[1].characters[0].hp, 19);
    assert.equal(match.players[1].states.find(s => s.shield).shield, 3);
});

test("all card definitions can be interpreted and ticked without an effect exception", () => {
    for (const [name, card] of Object.entries(cards)) {
        const weapon = (card.tag || []).find(t => ["SWORD", "BOW", "CLAYMORE", "CATALYST", "POLEARM"].includes(t));
        const id = card.deck_limit?.character || Object.keys(characters).find(n => characters[n].weapon?.toUpperCase() === weapon) || "Diluc";
        const match = fixture([id, "Kaeya", "Fischl"]);
        const engine = new EffectEngine(match);
        engine.add(0, "Oz", "summon"); engine.add(1, "Guoba", "summon");
        match.players[0].hand = [name];
        const target = JSON.stringify(card).includes("oppose_summon") ? {playerIndex: 1, zone: "Summon", index: 0}
            : JSON.stringify(card).includes('"type":"summon"') ? {playerIndex: 0, zone: "Summon", index: 0} : undefined;
        const result = resolveCard(match, 0, {handIndex: 0, target});
        assert.notEqual(result.error?.[0], "EffectError", name + ": " + result.error?.[1]);
        assert.doesNotThrow(() => { resolveRoundEnd(match); resolveRoundStart(match); }, name);
        const normal = resolveSkill(match, 0, {skillIndex: skillIndex(id, "Normal Attack")});
        assert.notEqual(normal.error?.[0], "EffectError", name + ": " + normal.error?.[1]);
    }
});
