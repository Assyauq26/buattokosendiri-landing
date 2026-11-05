# Landing repository guardrails

- Scope: central platform at `buattokosendiri.web.id`: landing, seller OTP/session, registration, provisioning controller, and guide. Seller runtime remains in `Assyauq26/buattokoonline`.
- Architecture superseded by owner's final M1 instructions dated 2026-11-05. No permanent staging. Tencent is the requested platform target; do not disturb existing Hubify or Helipod services.
- Do not invoke GitHub Actions. Local builds and relevant smoke/security tests are authorized by the M1 instructions.
- Do not auto-deploy on commit, pull request, or merge. Deployment needs an authorized operator, exact commit SHA, target validation, backup, and rollback.
- Preserve legacy registration data and its existing backend until separately audited and migrated. M1 owns `/api/platform/*`; never silently discard historical registrations.
- Keep images, font, PDF and installation guide working, with mobile and desktop layouts intact.
