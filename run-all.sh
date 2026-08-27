#!/usr/bin/env bash
# Start the whole site (all sports) on one port. Ctrl-C to stop.
#   http://localhost:3000/       landing
#   http://localhost:3000/nfl    /nhl  /nba  /mls
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-3000}" node server.js
