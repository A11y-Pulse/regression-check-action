<p align="center">
    <a href="https://www.a11ypulse.com/?utm_source=github&utm_content=regression-check-action-logo" target="_blank">
        <picture>
            <source srcset="https://app.a11ypulse.com/images/a11y-pulse-logo-white.png" media="(prefers-color-scheme: dark)" />
            <source srcset="https://app.a11ypulse.com/images/a11y-pulse-logo.png" media="(prefers-color-scheme: light), (prefers-color-scheme: no-preference)" />
            <img src="https://app.a11ypulse.com/images/a11y-pulse-logo.png" alt="A11y Pulse Logo">
        </picture>
    </a>
</p>

# A11y Pulse regression check

Catch accessibility regressions before they merge. This action uses [A11y Pulse](https://www.a11ypulse.com/features/pr-regression-checks/?utm_source=github&utm_content=regression-check-action-lead) to scan a pull request's preview deployment and a baseline of the same pages, then fails the job when the change adds accessibility issues. Results come from automated rules only, so a passing check does not mean a page has no barriers.

<sup>Made with ❤️ by the [A11y Pulse](https://www.a11ypulse.com/?utm_source=github&utm_content=regression-check-action-made-with) team in New Zealand.</sup>

The action has no dependencies and needs Node 24 on the runner. See the [regression checks docs](https://www.a11ypulse.com/docs/pr-regression-checks/#triggering-a-check-from-your-pipeline) for setup and the API key permissions the action needs.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `api-key` | yes | | A11y Pulse API key. Always pass it from `secrets`, never as a literal. |
| `site-id` | yes | | The site to check. |
| `head-url` | yes | | The preview URL. |
| `base-url` | yes | | The baseline URL to compare against. |
| `paths` | no | the site's monitored pages | Paths to check, one per line. |
| `base-ref` | no | `${{ github.event.pull_request.base.sha }}` | Git ref or SHA of the baseline. |
| `fail-on` | no | `serious` | The lowest impact that fails the check. |
| `timeout-minutes` | no | `10` | How long to wait before the job fails. |
| `api-url` | no | `https://api.a11ypulse.com` | The API URL. |

## Outputs

| Output | Description |
| --- | --- |
| `conclusion` | `success`, `failure` or `neutral`. |
| `report-url` | Link to the full report. |

The job fails when the conclusion is `failure`, when the check errors, or when it does not finish within `timeout-minutes`. A cancelled or timed-out check ends the job with a notice and does not fail it. A table of added issues is written to the job summary.

## Example

```yaml
name: Accessibility regression check
on:
  deployment_status:

jobs:
  regression-check:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: a11y-pulse/regression-check-action@v1
        with:
          api-key: ${{ secrets.A11Y_PULSE_API_KEY }}
          site-id: your-site-id
          head-url: ${{ github.event.deployment_status.environment_url }}
          base-url: https://www.example.com
```

## About A11y Pulse

[A11y Pulse](https://www.a11ypulse.com/?utm_source=github&utm_content=regression-check-action-about) is a web
accessibility monitoring platform. It scans websites for accessibility issues using real web
browsers, making it easier to reach WCAG compliance and maintain accessibility over time. A11y
Pulse combines its own interaction-driven audits with other open-source accessibility testing
frameworks to provide more coverage than most other tools.
