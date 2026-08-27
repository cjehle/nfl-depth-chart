// sports/_soccer.js — shared config factory for soccer leagues. Every league uses
// the same "match" builder (typical XI from recent matches, on a pitch) as MLS;
// only the ESPN league slug, team list, default matchup and name differ. EA FC
// ratings are per-league (data/ratings/<key>.json); leagues without a ratings map
// (e.g. Champions League) simply show no OVR badge. Not loaded as a sport itself
// (filename starts with "_"); each league file below requires this factory.
module.exports = function makeSoccerLeague({ key, name, league, defaults, ratings = true }) {
  return {
    key,
    name,
    emoji: "⚽",
    title: `${name} Starting XIs on the Pitch`,
    tagline: "Two teams' typical starting XIs from recent matches, in their usual formation — click any player for the depth at that line.",
    surface: "pitch",
    espn: { sport: "soccer", league },
    kind: "match",
    note: `Typical starting XI & formation from recent matches${ratings ? " · EA FC ratings" : ""} · via ESPN`,
    defaults,
    teams: require(`../data/${key}-teams.json`),
    bio: (a) => ({
      extra: a.citizenship || [a.birthPlace?.city, a.birthPlace?.country].filter(Boolean).join(", "),
      pos: a.position?.abbreviation || "",
    }),
  };
};
