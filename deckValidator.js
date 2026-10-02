export const DECK_CHARACTER_COUNT = 3;
export const DECK_CARD_COUNT = 30;
import { cards as cardDefinitions, findEntry, normalizeId } from "./gameData.js";

export function validateDeck(deck) {
  const characters = deck?.characters;
  const cards = deck?.cards;
  const errors = [];
  if (!Array.isArray(characters) || characters.length !== DECK_CHARACTER_COUNT)
    errors.push("A battle deck must contain exactly 3 characters");
  if (!Array.isArray(cards) || cards.length !== DECK_CARD_COUNT)
    errors.push("A battle deck must contain exactly 30 cards");
  if (Array.isArray(characters) && new Set(characters).size !== characters.length)
    errors.push("Character IDs must be unique");
  if ([...(characters ?? []), ...(cards ?? [])].some((id) => typeof id !== "string" || !id.trim()))
    errors.push("Deck entries must be non-empty string IDs");
  const copies = new Map();
  for (const id of cards ?? []) copies.set(id, (copies.get(id) ?? 0) + 1);
  if ([...copies.values()].some((count) => count > 3))
    errors.push("A deck may contain at most 3 copies of a card");
  for (const cardId of cards ?? []) {
    const definition = findEntry(cardDefinitions, cardId)?.[1];
    const required = definition?.deck_limit?.character;
    if (required && !(characters ?? []).some(id => normalizeId(id) === normalizeId(required)))
      errors.push(`${cardId} requires ${required} in the character lineup`);
  }
  return { valid: errors.length === 0, errors };
}
