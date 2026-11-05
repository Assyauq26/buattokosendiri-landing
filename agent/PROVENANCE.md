# Agent source provenance

These files mirror the reviewed adapter source in Assyauq26/buattokoonline
commit 4ecdb523cde85743903d90c4240ac3c0aabd0a6b.

- agent.py from installer/agent.py
- bootstrap.sh from installer/platform-bootstrap.sh

The adapter code is not a store release. The controller supplies a separate
approved tag and exact commit for the application. The platform serves the
bootstrap over HTTPS with the SHA-256 of the accompanying agent.
