export const WEATHER_TYPES = [
  "Rain", "Snow", "Thunderstorm", "Sandstorm", "Cataclysm", "BurningField", "Tornado",
];

export function createWeatherPlan(random = Math.random) {
  const sequence = Array.from({ length: 3 }, () => WEATHER_TYPES[Math.floor(random() * WEATHER_TYPES.length)]);
  const noWeatherRound = Math.floor(random() * 5) + 1;
  const rounds = [];
  let weatherIndex = 0;
  for (let round = 1; round <= 5; round += 1) {
    rounds.push(round === noWeatherRound ? "None" : sequence[weatherIndex++ % sequence.length]);
  }
  return { sequence, rounds, noWeatherRound };
}

function randomCharacter(player, random) {
  const alive = player.characters.filter((character) => character.hp > 0);
  return alive.length ? alive[Math.floor(random() * alive.length)] : null;
}

function applyElement(character, element) {
  if (character && !character.applications.includes(element)) character.applications.push(element);
}

export function applyWeather(match, random = Math.random) {
  const weather = match.weather.rounds[match.round - 1] ?? "None";
  match.attackDisabled = weather === "Sandstorm";
  match.reactionsDisabled = weather === "Cataclysm";
  const events = [{ eventType: "WeatherChanged", weather, round: match.round }];
  if (weather === "Rain" || weather === "Snow") {
    const element = weather === "Rain" ? "Hydro" : "Cryo";
    match.players.forEach((player) => player.characters.forEach((character) => applyElement(character, element)));
  } else if (weather === "Thunderstorm") {
    match.players.forEach((player, playerIndex) => {
      const character = randomCharacter(player, random);
      if (character) { applyElement(character, "Electro"); character.hp = Math.max(0, character.hp - 1); }
      events.push({ eventType: "CharacterDamaged", playerIndex, characterId: character?.characterId ?? "", amount: character ? 1 : 0 });
    });
  } else if (weather === "Cataclysm") {
    match.players.forEach((player) => player.characters.forEach((character) => { character.applications = []; }));
  } else {
    if (weather === "BurningField") {
      match.players.forEach((player) => { player.summons = []; applyElement(randomCharacter(player, random), "Pyro"); });
    } else if (weather === "Tornado") {
      match.players.forEach((player) => {
        player.deck.push(...player.hand);
        player.hand = [];
        shuffle(player.deck, random);
        draw(player, 3);
      });
    }
  }
  return events;
}

export function shuffle(values, random = Math.random) {
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
}

export function draw(player, count) {
  player.hand.push(...player.deck.splice(0, Math.min(count, player.deck.length)));
}
