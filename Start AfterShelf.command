#!/bin/zsh
cd "${0:A:h}" || exit 1
if ! command -v npm >/dev/null 2>&1; then
  print "Node.js and npm are required to run this development build."
  read -r "reply?Press Return to close."
  exit 1
fi
npm start
