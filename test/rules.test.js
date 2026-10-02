import assert from "node:assert/strict";
import test from "node:test";
import { validateDeck } from "../deckValidator.js";
import { applyWeather, createWeatherPlan } from "../weather.js";

test("battle decks require three characters and thirty cards", () => {
  const cards = Array.from({ length: 30 }, (_, index) => `card-${index}`);
  assert.equal(validateDeck({ characters: ["A", "B", "C"], cards }).valid, true);
  assert.equal(validateDeck({ characters: ["A", "B"], cards }).valid, false);
  assert.equal(validateDeck({ characters: ["A", "B", "C"], cards: cards.slice(1) }).valid, false);
});

test("weather plan has three shuffle results, four events, and one clear round", () => {
  const plan = createWeatherPlan(() => 0);
  assert.equal(plan.sequence.length, 3);
  assert.equal(plan.rounds.length, 5);
  assert.equal(plan.rounds.filter((weather) => weather === "None").length, 1);
  assert.equal(plan.rounds.filter((weather) => weather !== "None").length, 4);
});

test("thunderstorm applies electro and damage to one character per player", () => {
  const character = (id) => ({ characterId: id, hp: 10, applications: [] });
  const match = {
    round: 1,
    weather: { rounds: ["Thunderstorm"] },
    players: [
      { characters: [character("A"), character("B")] },
      { characters: [character("C"), character("D")] },
    ],
  };
  applyWeather(match, () => 0);
  assert.deepEqual(match.players.map((player) => player.characters[0].hp), [9, 9]);
  assert.deepEqual(match.players.map((player) => player.characters[0].applications), [["Electro"], ["Electro"]]);
});
