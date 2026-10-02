import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { EffectEngine } from "../effectEngine.js";
import { LumieServer } from "../server.js";
import { availability, resolveSkill, resolveCard, resetRoundLimits } from "../gameLogic.js";
import { characters, findEntry } from "../gameData.js";

function player(ids = ["Diluc", "Fischl", "Ganyu"]) {
    return {
        characters: ids.map(characterId => ({ characterId, hp: 20, maxHp: 20, energy: 3, maxEnergy: 3, applications: [], skillUses: {} })),
        activeCharacterIndex: 0, elementPoints: 50, hand: ["SweetMadame"], deck: ["SweetMadame"],
        states: [], summons: [], switchesUsed: 0, remainingMs: 180000, turnStartedAt: Date.now(),
    };
}
function fixture(t) {
    const server = new LumieServer();
    server.logServer = () => {};
    const messages = [[], []];
    const sockets = messages.map(queue => ({ readyState: 1, send: raw => queue.push(JSON.parse(raw)) }));
    const match = { id: "test", started: true, sockets, players: [player(), player()], round: 1, roundStarterIndex: 0,
        currentPlayerIndex: 0, ended: new Set(), weather: { rounds: ["None", "None"], sequence: [] } };
    sockets.forEach((socket, i) => server.clients.set(socket, { id: String(i), nickname: `Player ${i}`, matchId: match.id }));
    server.matches.set(match.id, match);
    t.after(() => clearTimeout(match.timer));
    function command(index, commandType, command = {}) {
        server.gameCommand(sockets[index], { matchId: match.id, commandType, command });
    }
    return { server, match, messages, command };
}
const skillIndex = (id, type) => Object.values(findEntry(characters, id)[1].skills).findIndex(s => s.type.includes(type));

test("every client/server skill has a configurable maxUse", () => {
    const local = JSON.parse(fs.readFileSync(new URL("../../json/character.json", import.meta.url))).standard;
    for (const [name, character] of Object.entries(characters)) {
        for (const [skill, definition] of Object.entries(character.skills)) {
            assert.ok(Number.isInteger(definition.maxUse) && definition.maxUse >= 0);
            assert.equal(findEntry(local, name)[1].skills[skill].maxUse, definition.maxUse);
        }
    }
});

test("skill limit is per skill and per character; rejection spends nothing; next round resets", () => {
    const match = { players: [player(), player()] };
    const owner = match.players[0];
    const normal = skillIndex("Diluc", "Normal Attack");
    assert.ok(!resolveSkill(match, 0, { skillIndex: normal }).error);
    const before = structuredClone(match);
    assert.equal(resolveSkill(match, 0, { skillIndex: normal }).error[0], "SkillUseLimit");
    assert.deepEqual(match, before);
    assert.equal(availability(owner)[normal].remainingUses, 0);
    assert.equal(availability(owner)[normal].available, false);
    assert.ok(!resolveSkill(match, 0, { skillIndex: skillIndex("Diluc", "Elemental Skill") }).error);
    owner.activeCharacterIndex = 1;
    assert.ok(!resolveSkill(match, 0, { skillIndex: skillIndex("Fischl", "Normal Attack") }).error);
    resetRoundLimits(owner);
    owner.activeCharacterIndex = 0;
    assert.equal(availability(owner)[normal].remainingUses, 1);
    assert.ok(!resolveSkill(match, 0, { skillIndex: normal }).error);
});

test("maxUse greater than one also controls bursts; zero disables a skill", () => {
    const index = skillIndex("Diluc", "Elemental Burst");
    const definition = Object.values(characters.Diluc.skills)[index];
    const original = definition.maxUse;
    try {
        definition.maxUse = 2;
        const match = { players: [player(), player()] };
        const actor = match.players[0].characters[0];
        assert.ok(!resolveSkill(match, 0, { skillIndex: index }).error);
        actor.energy = 3;
        assert.ok(!resolveSkill(match, 0, { skillIndex: index }).error);
        actor.energy = 3;
        assert.equal(resolveSkill(match, 0, { skillIndex: index }).error[0], "SkillUseLimit");
        definition.maxUse = 0;
        resetRoundLimits(match.players[0]);
        assert.equal(availability(match.players[0])[index].available, false);
        assert.equal(resolveSkill(match, 0, { skillIndex: index }).error[0], "SkillUseLimit");
    } finally { definition.maxUse = original; }
});

test("normal switch only once per round, including ChooseActiveCharacter alias", t => {
    const { match, command, messages } = fixture(t);
    command(0, "SwitchCharacter", { characterIndex: 1 });
    assert.equal(match.players[0].switchesUsed, 1);
    command(1, "EndRound");
    command(0, "ChooseActiveCharacter", { characterIndex: 2 });
    assert.equal(match.players[0].activeCharacterIndex, 1);
    assert.ok(messages[0].some(m => m.payload.code === "SwitchLimit"));
    command(0, "EndRound");
    assert.equal(match.round, 2);
    assert.equal(match.players[0].switchesUsed, 0);
    command(1, "EndRound");
    command(0, "SwitchCharacter", { characterIndex: 2 });
    assert.equal(match.players[0].activeCharacterIndex, 2);
});

test("knockout pauses attacker; ended defender may replace for free and restore attacker state", t => {
    const { match, command, messages } = fixture(t);
    match.ended.add(1);
    match.players[1].switchesUsed = 1;
    match.players[1].characters[0].hp = 1;
    command(0, "UseSkill", { skillIndex: skillIndex("Diluc", "Normal Attack") });
    assert.deepEqual(match.pendingReplacement, { playerIndex: 1, resumePlayerIndex: 0 });
    assert.equal(match.currentPlayerIndex, 1);
    const attacker = structuredClone(match.players[0]);
    command(0, "PlayCard", { handIndex: 0 });
    command(1, "EndRound");
    command(1, "UseSkill", { skillIndex: 0 });
    assert.ok(messages[1].some(m => m.payload.code === "ReplacementRequired"));
    assert.deepEqual(match.players[0], attacker);
    command(1, "ChooseActiveCharacter", { characterIndex: 0 });
    assert.equal(match.currentPlayerIndex, 1);
    command(1, "ChooseActiveCharacter", { characterIndex: 1 });
    assert.equal(match.currentPlayerIndex, 0);
    assert.equal(match.pendingReplacement, null);
    assert.equal(match.players[1].switchesUsed, 1);
    assert.ok(match.ended.has(1));
    const resumed = { ...match.players[0], turnStartedAt: attacker.turnStartedAt };
    assert.deepEqual(resumed, attacker);
    const snapshot = messages[0].filter(m => m.type === "GameSnapshot").at(-1).payload;
    assert.equal(snapshot.pendingReplacement, null);
    assert.equal(snapshot.players[1].switchesRemaining, 0);
});

test("knockout through talent card also requires replacement", t => {
    const { match, command } = fixture(t);
    match.players[0] = player(["Ganyu", "Diluc", "Fischl"]);
    match.players[0].hand = ["UndividedHeart"];
    match.players[1].characters[0].hp = 1;
    command(0, "PlayCard", { handIndex: 0 });
    assert.equal(match.players[0].hand.length, 0);
    assert.equal(match.pendingReplacement.playerIndex, 1);
    assert.equal(match.players[0].characters[0].skillUses["Frostflake Arrow"], 1);
});

test("talent cannot bypass maxUse or consume the card on rejection", () => {
    const match = { players: [player(["Ganyu", "Diluc", "Fischl"]), player()] };
    const owner = match.players[0];
    owner.hand = ["UndividedHeart"];
    owner.characters[0].skillUses["Frostflake Arrow"] = 1;
    const before = structuredClone(match);
    assert.equal(resolveCard(match, 0, { handIndex: 0 }).error[0], "SkillUseLimit");
    assert.deepEqual(match, before);
});

test("last character defeated ends match immediately instead of asking for replacement", t => {
    const { server, match, command, messages } = fixture(t);
    match.players[1].characters.forEach((c, index) => { c.hp = index === 0 ? 1 : 0; });
    command(0, "UseSkill", { skillIndex: skillIndex("Diluc", "Normal Attack") });
    assert.equal(server.matches.has(match.id), false);
    assert.ok(messages[0].some(m => m.payload.events?.some(e => e.eventType === "GameEnded" && e.winnerIndex === 0)));
});

test("skills create typed summon/state entries with JSON icon metadata", () => {
    const match = { players: [player(["Fischl", "Ganyu", "Diluc"]), player()] };
    assert.ok(!resolveSkill(match, 0, { skillIndex: skillIndex("Fischl", "Elemental Skill") }).error);
    assert.equal(match.players[0].summons[0].name, "Oz");
    assert.equal(match.players[0].summons[0].kind, "summon");
    match.players[0].activeCharacterIndex = 1;
    assert.ok(!resolveSkill(match, 0, { skillIndex: skillIndex("Ganyu", "Elemental Skill") }).error);
    assert.equal(match.players[0].states[0].name, "Ice Lotus");
    assert.equal(match.players[0].states[0].icon, "times_shield");
});

test("Abyssal Summons resolves its random group to an image-backed concrete summon", () => {
    const match = { players: [player(), player()] };
    match.players[0].hand = ["AbyssalSummons"];
    assert.ok(!resolveCard(match, 0, { handIndex: 0 }).error);
    const summon = match.players[0].summons[0];
    assert.notEqual(summon.name, "Hilichurl Summon");
    assert.equal(summon.usage, 2);
    assert.ok(fs.existsSync(new URL("../../assets/summons/" + summon.name.replace(/[^a-z0-9]/gi, "") + ".png", import.meta.url)));
});


test("lethal round-end summon ends the match before the next round or opposing summon", t => {
    const { server, match, command, messages } = fixture(t);
    new EffectEngine(match).add(0, "Guoba", "summon");
    new EffectEngine(match).add(1, "Guoba", "summon");
    match.players[1].characters.forEach((c, index) => { c.hp = index === 0 ? 1 : 0; });
    const hp = match.players[0].characters[0].hp;
    command(0, "EndRound");
    command(1, "EndRound");
    assert.equal(server.matches.has(match.id), false);
    assert.equal(match.round, 1);
    assert.equal(match.players[0].characters[0].hp, hp);
    assert.ok(messages[0].some(m => m.payload.events?.some(e => e.eventType === "GameEnded" && e.winnerIndex === 0)));
});
