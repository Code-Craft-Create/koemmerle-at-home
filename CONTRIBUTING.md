# Contributing

Thanks for considering a contribution to KoemmerleAtHome.

## License

By submitting a contribution, you agree that your contribution is licensed
under the Apache License, Version 2.0, the same license used by this project,
unless you clearly state otherwise before the contribution is accepted.

## Development

- Keep changes focused and easy to review.
- Do not commit local databases, certificates, browser sessions, secrets,
  generated build output, or dependency folders.
- Update `THIRD-PARTY-NOTICES.md` when adding, removing, or upgrading
  dependencies that affect licensing.

## Frontend

The frontend lives in `frontend/koemmerle-at-home`.

```bash
npm install
npm start
npm run build
```

## Backend

The backend lives in `backend/KoemmerleAtHome.Api`.

```bash
dotnet restore
dotnet build
dotnet test
```