import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { LumieServer } from "../server.js";

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function receive(socket, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 2000);
    const listener = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== type) return;
      clearTimeout(timeout);
      socket.off("message", listener);
      resolve(message);
    };
    socket.on("message", listener);
  });
}

function send(socket, type, payload = {}) {
  socket.send(JSON.stringify({ type, payload }));
}

test("Qt client protocol can authenticate and create a match", async (t) => {
  const server = new LumieServer({ port: 0 });
  const address = await server.start();
  t.after(() => server.stop());
  const url = `ws://127.0.0.1:${address.port}`;
  const alice = await connect(url);
  const bob = await connect(url);
  t.after(() => { alice.close(); bob.close(); });

  const aliceAuth = receive(alice, "AuthResult");
  send(alice, "AuthRequest", { mode: "guest", nickname: "Alice" });
  assert.equal((await aliceAuth).payload.success, true);
  const bobAuth = receive(bob, "AuthResult");
  send(bob, "AuthRequest", { mode: "guest", nickname: "Bob" });
  assert.equal((await bobAuth).payload.nickname, "Bob");

  const aliceFound = receive(alice, "MatchFound");
  const bobFound = receive(bob, "MatchFound");
  send(alice, "MatchmakingStart", { mode: "Game1", deckId: "default_deck" });
  send(bob, "MatchmakingStart", { mode: "Game1", deckId: "default_deck" });
  const [aliceMatch, bobMatch] = await Promise.all([aliceFound, bobFound]);
  assert.equal(aliceMatch.payload.matchId, bobMatch.payload.matchId);
  assert.equal(aliceMatch.payload.opponentName, "Bob");
  assert.equal(bobMatch.payload.playerIndex, 1);
  assert.equal(aliceMatch.payload.weatherSequence.length, 3);

  const cards = Array.from({ length: 30 }, (_, index) => `card-${index}`);
  const aliceSnapshot = receive(alice, "GameSnapshot");
  const bobSnapshot = receive(bob, "GameSnapshot");
  send(alice, "SubmitDeck", { deckId: "deck1", characters: ["A", "B", "C"], cards });
  send(bob, "SubmitDeck", { deckId: "deck1", characters: ["D", "E", "F"], cards });
  assert.equal((await aliceSnapshot).payload.self.handCardIds.length, 5);
  assert.equal((await bobSnapshot).payload.stage, "Action");

  const afterAliceEnds = receive(bob, "GameSnapshot");
  send(alice, "GameCommand", { matchId: aliceMatch.payload.matchId, commandType: "EndRound", command: {} });
  assert.equal((await afterAliceEnds).payload.players[0].endedRound, true);

  const afterBobActs = receive(bob, "GameSnapshot");
  send(bob, "GameCommand", { matchId: bobMatch.payload.matchId, commandType: "UseSkill", command: { skillIndex: 0, elementPointCost: 0 } });
  assert.equal((await afterBobActs).payload.currentPlayerIndex, 1);

  const nextRound = receive(alice, "GameSnapshot");
  send(bob, "GameCommand", { matchId: bobMatch.payload.matchId, commandType: "EndRound", command: {} });
  assert.equal((await nextRound).payload.round, 2);
});

test("server returns protocol errors instead of terminating", async (t) => {
  const server = new LumieServer({ port: 0 });
  const address = await server.start();
  t.after(() => server.stop());
  const socket = await connect(`ws://127.0.0.1:${address.port}`);
  t.after(() => socket.close());

  const invalidJson = receive(socket, "Error");
  socket.send("not json");
  assert.equal((await invalidJson).payload.code, "InvalidJson");

  const unauthenticated = receive(socket, "Error");
  send(socket, "MatchmakingStart", { mode: "Game1" });
  assert.equal((await unauthenticated).payload.code, "NotAuthenticated");
});
