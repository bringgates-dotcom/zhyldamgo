# zhyldamgo

The Netlify application is in `zhyldam-netlify/`. The repository-root
`netlify.toml` sets that folder as the base directory, so Netlify installs the
application's dependencies, publishes `zhyldam-netlify/public/`, and deploys
functions from `zhyldam-netlify/netlify/functions/`.

No build command is required: the static frontend is already committed as
`zhyldam-netlify/public/index.html`.

See `zhyldam-netlify/README.md` for application setup and Telegram configuration.
