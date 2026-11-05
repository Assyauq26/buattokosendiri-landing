# Landing repository guardrails

- Scope: only the public static landing page at `buattokosendiri.web.id`.
- Do not modify seller application, registration backend, database, installer, or other repositories through this codebase.
- Do not invoke CI or automated tests unless explicitly requested by the owner. The GitHub Actions workflow is manual-only (`workflow_dispatch`).
- Do not auto-deploy on commit, pull request, or merge. Deployment needs an authorized operator, exact commit SHA, target validation, backup, and rollback.
- Preserve `/api/registration` routing when landing content is deployed. The API is external to this repository.
- Keep images, font, PDF and installation guide working, with mobile and desktop layouts intact.
