# Security policy

## Reporting

Do not open a public Issue for suspected vulnerabilities. Use a private
[GitHub security advisory](https://github.com/Sannrox/aldunis-code/security/advisories/new).

Include the affected revision, local operating system, reproduction steps,
impact, and a minimal redacted proof. Never attach credentials, private source
code, provider transcripts, customer data, or unredacted logs.

## Current posture

Aldunis Code is pre-release software and is not yet supported for production
or unattended execution. The application must bind to loopback by default.
Provider credentials remain in provider-supported local stores and must never
be sent to the browser, logs, or repository.

