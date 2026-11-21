# Ellsworth apps

Company apps that work with no signal. Each one keeps its data on the phone and syncs to a private Google Sheet when there's service.

- `parts/`: Parts, for the filters, teeth and service parts in stock.
- `photos/`: Job Photos, for the photos of each job. A cloud hub: photos go to Google Drive and the app shows them from there, so they don't take up space on phones. A photo taken with no signal waits on the phone only until there's service, then it's sent and cleared off.

This repository only holds the apps themselves. No company data is stored here; each app asks for a code the first time it opens.
