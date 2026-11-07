# Agent source provenance

The automatic-mail-provisioning candidate reconciles this repository's current
pairing/password/reconnect fixes into `Assyauq26/buattokoonline/installer/agent.py`.
The two agent.py files must be byte-identical at release review. The historical
4ecdb523 source reference no longer described the production platform adapter.

- agent.py from installer/agent.py
- bootstrap.sh from installer/platform-bootstrap.sh

The adapter code is not a store release. The controller supplies a separate
approved tag and exact commit for the application. The platform serves the
bootstrap over HTTPS with the SHA-256 of the accompanying agent.
