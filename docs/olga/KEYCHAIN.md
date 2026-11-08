# Separate a1 Keychain setup (not performed)

No secret is stored in this repository, and this candidate never calls `security`, never reads `KALSHI_API_KEY`, and never reads a private key. Do not copy the a2 connector key, its PEM, or its launchd environment.

Official references used for the later manual step:

- [API keys](https://docs.kalshi.com/getting_started/api_keys) — Ed25519 or RSA. The private key is shown once.
- [Authenticated requests](https://docs.kalshi.com/getting_started/quick_start_authenticated_requests) — headers `KALSHI-ACCESS-KEY`, `KALSHI-ACCESS-TIMESTAMP`, and `KALSHI-ACCESS-SIGNATURE`. Sign `timestamp + METHOD + path` without the query string.
- [Subaccounts](https://docs.kalshi.com/getting_started/subaccounts) — primary is `0`, numbered subaccounts are `1`–`63`. A key can be restricted to one subaccount.
- [Get balance](https://docs.kalshi.com/api-reference/portfolio/get-balance) — `subaccount` defaults to primary. A restricted key must omit it or pass its own subaccount.

A different API key id does not by itself prove a different Kalshi member. The binding record therefore has three public fields, all empty in this disabled candidate: the a1 key id, the member id, and the subaccount. Unknown or mismatched values fail closed. The private key is not one of those fields.

When a later approval says to create the key, do it in Kalshi's own account settings for the intended a1 account, then import it on Olga with the Keychain service name `mcp-kalshi-a1` and account label `olga-a1`. Unattended Keychain ACL access is unverified. Do not rehearse that import from this repository.

The candidate does not create, list, or sign with a key. Readiness of the item is `missing`.
