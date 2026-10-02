import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const directory = path.dirname(fileURLToPath(import.meta.url));
const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
export const characters = read("character.json").standard;
export const cards = read("card.json").standard;
export const states = read("state.json");
export const summons = read("summon.json");
export const normalizeId = value =>
    String(value ?? "")
        .replace(/[^a-z0-9]/gi, "")
        .toLowerCase();
export function findEntry(collection, requested) {
    const key = Object.keys(collection).find(name => normalizeId(name) === normalizeId(requested));
    return key ? [key, collection[key]] : null;
}
export function pointCost(cost = {}) {
    return Object.entries(cost)
        .filter(([key]) => key !== "ENERGY")
        .reduce((sum, [, v]) => sum + Number(v || 0), 0);
}
