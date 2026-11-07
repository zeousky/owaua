# Public release checklist

The maintainer changes GitHub visibility after reviewing the release. Changing visibility exposes every remote branch and tag, their commit contents, commit messages, and author metadata. A clean current checkout alone is not enough.

Before changing visibility:

1. Run `npm ci`, `npm run check`, and `npm test` without loading production credentials. Run `npm audit --omit=dev`.
2. Fetch all remote branches and tags, then run `gitleaks git . --log-opts="--all --full-history" --redact --no-banner` with Gitleaks 8.30.1. Review findings; the only configured exceptions are two exact fake test credentials.
3. Check all historical filenames for databases, backups, logs, private extensions, and credential files. Review commit author and committer metadata as well as commit messages for personal information.
4. If anonymized history has been prepared, review it and explicitly approve replacing GitHub's existing branches and tags before changing visibility. Keep the original history backup private. History rewrites change commit IDs, require collaborators to synchronize their clones, and can leave old commits accessible through existing links or GitHub references.
5. Confirm the MIT license, self-hosting instructions, `.env.example`, and security-reporting links describe what is actually included. Use your own Discord application and provider keys for a fork.
6. Check the repository's Actions settings: use read-only default token permissions, require approval for outside contributors, and use GitHub-hosted runners. CI needs no bot token or provider key. Keep deployment credentials out of pull-request workflows.

After changing visibility:

- Enable private vulnerability reporting in the repository's Security settings so the private-report link works. Enable GitHub secret scanning and push protection where available.
- Confirm the CI checks pass and choose required checks in branch rules if you want to prevent unverified merges.
- Review container package visibility separately if you want anonymous pulls. Source builds work independently of the registry.
- Test the README and release links while signed out. Review issues, pull requests, release assets, and Actions logs before sharing the repository widely; a Git scan does not cover those surfaces.

Never publish `.env`, `data/`, backups, or local extensions. If a real credential was committed, revoke it first; removing it from the current files or rewriting history does not revoke it.
