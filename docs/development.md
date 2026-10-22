# For developers

SerieX is written in Go (the two servers) and TypeScript with React (the screens). The desktop app uses Electron. Each company is a single SQLite database file (`.sxb` for SerieX Books, `.sxp` for SerieX Payroll).

## What you need

- Go 1.25 or later (build releases with the newest Go release, at least Go 1.26.10, which has security fixes the servers need)
- Node.js 22.12 or later, with npm
- Git
- xz, for the Ubuntu packages (on a Mac: `brew install xz`). The first Ubuntu build downloads Electron for Linux and the packaging tools of electron-builder (the tool that makes the installers) from GitHub.

## Run SerieX Books from source

On macOS or Linux:

```sh
git clone https://github.com/CapitalFee/SerieX.git
cd SerieX
./start-books.sh
```

Then open http://127.0.0.1:8080. The script installs the web packages the first time, builds the screens and the server, and starts it. To use another port, pass it as the first argument (for example `./start-books.sh 8081`).

The script uses the same company files folder as the desktop app, so both show the same companies. Do not run both at the same time. To use another folder, set `SERIEX_DATA_DIR` (for example `SERIEX_DATA_DIR="$HOME/seriex-dev" ./start-books.sh`).

## Run SerieX Payroll from source

SerieX Payroll works together with SerieX Books, so start SerieX Books first. Then, in another terminal, from the `SerieX` folder:

```sh
cd payroll/web && npm install && npm run build
cd ../server && go build . && ./seriexpayroll
```

Then open http://127.0.0.1:8090. Payroll company files go to `payroll/server/data` (change it with `-data <folder>`). SerieX Payroll looks for SerieX Books at http://127.0.0.1:8080 (change it with `-books <address>`). With both running, the **apps** button switches between them. Run `./seriexpayroll -h` to see every option.

## Build the desktop app and installers

```sh
(cd web && npm install)
(cd payroll/web && npm install)
cd desktop
npm install
npm run build:mac     # Mac installers, Apple silicon and Intel
npm run build:win     # Windows installer
npm run build:linux   # Ubuntu packages (.deb, amd64 and arm64)
npm run build:all     # Mac, Windows and Ubuntu
```

The installers are written to `desktop/dist/`. The Ubuntu packages are `desktop/dist/SerieX-linux-amd64.deb` and `SerieX-linux-arm64.deb`. After `npm run build:mac` on a Mac, `npm start` runs the desktop app straight from the source folder.

To check that an Ubuntu package installs, try it in a Docker container (a throwaway Ubuntu system). From the `SerieX` folder:

```sh
docker run --rm -it -v "$PWD/desktop/dist:/dist:ro" ubuntu:24.04 bash -c 'apt-get update && apt-get install -y /dist/SerieX-linux-arm64.deb'
```

The arm64 package runs at full speed on an Apple silicon Mac. For the amd64 package, add `--platform linux/amd64` after `run` and use `SerieX-linux-amd64.deb`; it runs slowly, because the Mac imitates an Intel processor.

Maintainers publish a release with `npm run publish -- --commit <commit>` in `desktop/` (see `desktop/scripts/publish.mjs`).

To check the TypeScript code, run `npm run typecheck` in `web/` or `payroll/web/`.

## Project layout

| Folder | What is in it |
|---|---|
| `server/` | SerieX Books server (Go): accounting rules, company files, reports, backups, imports |
| `web/` | SerieX Books screens (React and TypeScript) |
| `payroll/server/` | SerieX Payroll server (Go): pay calculations, tax tables, tax forms, posting to SerieX Books |
| `payroll/web/` | SerieX Payroll screens (React and TypeScript) |
| `desktop/` | The desktop app (Electron), the installer build scripts, and the install scripts in `desktop/release/` |
| `mcp/` | The connection that lets AI assistants on your computer read SerieX (Model Context Protocol) and its small helper program |
| `skills/` | Guidance that teaches AI assistants how SerieX and bookkeeping work |
| `start-books.sh` | Builds and starts SerieX Books for development |
| `docs/` | This guide, the user guide, privacy and legal notes, and the screenshots in the README |
