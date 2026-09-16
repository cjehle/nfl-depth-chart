// lib/types.js — JSDoc @typedefs for the data contracts, so an editor/LSP (and a future AI)
// gets types with NO build step. This module is comment-only and intentionally exports nothing;
// nothing requires it at runtime. It documents the shapes; CONTRACTS.md is the prose version and
// sports/README.md the config schema. Reference from another file with:  /** @type {import("./types").SportConfig} */
//
// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------
/**
 * @typedef {Object} Player
 * @property {number} rank              1 = starter/most-ranked at the spot
 * @property {string|null} id           ESPN athlete id (headshot/profile derived client-side from id + webSlug)
 * @property {string} name
 * @property {string} [jersey]
 * @property {string} [pos]             position code (surface sports)
 * @property {number|null} [overall]    video-game OVR (Madden/The Show/EA FC), or null
 * @property {number|null} [age]        OR use classYear for college
 * @property {string} [classYear]       FR|SO|JR|SR (classYears sports)
 * @property {string} [height]
 * @property {string} [weight]
 * @property {string} [college]
 * @property {number|null} [exp]        years pro (NFL)
 * @property {string|null} [injury]     ESPN injury status when present
 * @property {Object} [injuryDetail]    richer { detail, ret } when present
 * @property {string} [extra]           sport-specific bio line (from cfg.bio())
 * @property {Object} [draft]           NHL-draft badge (draftStatus sports)
 */

// ---------------------------------------------------------------------------
// Surface envelope (lib/espn.js buildLineup) — served by GET /api/lineup
// ---------------------------------------------------------------------------
/**
 * @typedef {Object} Chip
 * @property {string} key
 * @property {string} label
 * @property {string} [group]           List-view grouping header
 * @property {number} x                 0–100 % across the surface
 * @property {number} y                 0–100 % down the surface
 * @property {Player} face              the on-surface player
 * @property {Player[]} players         full depth at this spot (face is the healthy pick)
 */
/**
 * @typedef {Object} LineupEnvelope
 * @property {string} sport             cfg.key
 * @property {string} surface           rink|court|pitch|diamond|field
 * @property {boolean} dualUnit
 * @property {string|null} unit         which unit this payload is (null if single-unit)
 * @property {string|null} ratingLabel  OVR badge label, or null
 * @property {boolean} draftStatus
 * @property {number|null} season       non-null for a past season
 * @property {{abbr:string,name:string,color?:string,logo?:string}} [team]
 * @property {string|null} [record]
 * @property {Object|null} [next]
 * @property {string} [formation]
 * @property {string} [subtitle]
 * @property {string} [updated]
 * @property {Chip[]} chips
 * @property {boolean} [stale]          true ONLY when served from seed/last-good
 * @property {string} [source]          "seed" | "last-good" (present with stale)
 */

// ---------------------------------------------------------------------------
// NFL envelope (lib/nfl.js makeEnvelope) — served by GET /api/depth
// ---------------------------------------------------------------------------
/**
 * @typedef {Object} Spot
 * @property {number} slot
 * @property {Player[]} players
 */
/**
 * @typedef {Object} PositionGroup
 * @property {string} abbr
 * @property {string} [cat]             defensive bucket (DL/LB/CB/S/NB) when applicable
 * @property {Spot[]} spots
 */
/**
 * @typedef {Object} Unit
 * @property {string} formation
 * @property {Object.<string, PositionGroup>} positions   keyed by position key
 */
/**
 * @typedef {Object} NflEnvelope
 * @property {string} team
 * @property {string} teamAbbr
 * @property {number} season
 * @property {string} fetchedAt
 * @property {string|null} record
 * @property {Object|null} next
 * @property {Unit|null} offense
 * @property {Unit|null} defense
 * @property {Unit|null} specialTeams
 * @property {boolean} [stale]
 * @property {string} [source]
 */

// ---------------------------------------------------------------------------
// Per-sport config (sports/<key>.js) — see sports/README.md for the full schema
// ---------------------------------------------------------------------------
/**
 * @typedef {Object} SportConfig
 * @property {string} key               MUST equal the filename
 * @property {string} name
 * @property {string} emoji
 * @property {string} title
 * @property {string} tagline
 * @property {string} surface           rink|court|pitch|diamond|field
 * @property {{sport:string,league:string}} espn
 * @property {"match"|"statrank"|"boxstart"|"roster"|"depth"} kind   selects the builder in buildLineup()
 * @property {{a:(string|number),b?:(string|number)}} defaults        ids MUST exist in teams
 * @property {Array<{id:(string|number),name:string,conf?:string,abbr?:string,color?:string}>} teams
 * @property {(athlete:Object) => {extra?:string,pos?:string}} bio
 * @property {(pos:string) => (string|null)} [bucket]   required for kind boxstart|roster
 * @property {Array<Object>} [layout]                   spots; required except kind=match
 * @property {{offense:Array<Object>,defense:Array<Object>}} [layouts]   dual-unit roster (CFB)
 * @property {Object} [packages]        per-unit formation packages (CFB)
 * @property {boolean} [history]
 * @property {boolean} [singleTeam]
 * @property {boolean} [seasonEndYear]
 * @property {boolean} [dualUnit]
 * @property {string[]} [units]         length 2 when dualUnit
 * @property {string[]} [unitLabels]    length 2 when dualUnit
 * @property {string[]} [formations]
 * @property {"court"|"server"|"unit"} [formationMode]
 * @property {boolean} [classYears]
 * @property {boolean} [defaultVsNext]  open team A vs its next scheduled opponent on a fresh visit (two-team sports)
 * @property {string} [note]
 * @property {string} [rosterLabel]
 */

module.exports = {}; // no runtime exports — types only
