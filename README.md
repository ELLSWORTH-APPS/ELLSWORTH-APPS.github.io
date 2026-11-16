# Ellsworth apps

Company apps that work with no signal. Each one keeps its data on the phone and syncs to a private Google Sheet when there's service.

- `parts/`: Parts, for the filters, teeth and service parts in stock.
- `photos/`: Job Photos, for the photos of each job. Photos taken with no signal wait on the phone and send when there's service; the photos themselves go to Google Drive.

This repository only holds the apps themselves. No company data is stored here; each app asks for a code the first time it opens.
