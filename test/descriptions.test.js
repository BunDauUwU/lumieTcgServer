import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import { cards, characters } from "../gameData.js";
const description = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL("../../qml/Core/CardDescription.js", import.meta.url), "utf8"), description);

test("card text derives complete cost, healing and talent requirements from JSON", () => {
    assert.match(description.describe(cards["Sweet Madame"]), /Restore 1 HP/);
    const talent = description.describe(cards["Stonehide Reforged"]);
    assert.match(talent, /4 EP \+ 2 Energy/);
    assert.match(talent, /Required character: Stonehide Lawachurl/);
    assert.match(talent, /Use skill: Upa Shato/);
    assert.match(talent, /After an attack/);
});

test("character description exposes configurable per-round skill limits and summons", () => {
    const text = description.describeCharacter(characters.Fischl);
    assert.match(text, /Nightrider/);
    assert.match(text, /Summon Oz/);
    assert.match(text, /1 use\(s\) per round/);
});

test("every JSON card produces readable text without undefined or object dumps", () => {
    for (const card of Object.values(cards)) {
        const text = description.describe(card);
        assert.ok(text.length > 0);
        assert.doesNotMatch(text, /undefined|\[object Object\]/);
    }
});
