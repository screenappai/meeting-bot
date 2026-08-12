# Zoom RTMS operations and customer onboarding

This guide covers three supported RTMS credential use cases:

1. An internal private Zoom app used only by the developer's own Zoom account.
2. One shared Zoom RTMS app with customer OAuth credentials selected by exact Winkk `teamId`.
3. A separate private Zoom RTMS app and OAuth app for each customer, also selected by exact `teamId`.

RTMS does not join a meeting as an anonymous participant. It streams meeting media for an authorized Zoom user. The meeting URL is used only to extract the meeting ID; its password does not authorize RTMS.

## Deployment modes

| Mode | Configuration | Behavior |
| --- | --- | --- |
| Browser only | `ZOOM_RECORDING_TRANSPORT=browser`, fallback disabled | Never uses RTMS |
| Browser then RTMS | `ZOOM_RECORDING_TRANSPORT=browser`, `ZOOM_RTMS_FALLBACK_ENABLED=true` | Uses RTMS only after an explicit automated-bot block before browser admission |
| Forced RTMS | `ZOOM_RECORDING_TRANSPORT=rtms` | Uses RTMS directly and never starts Chrome for Zoom |

Transport selection is independent from credential selection:

| Credential profile | Selection | RTMS General app | OAuth control app |
| --- | --- | --- | --- |
| Internal | Exact `ZOOM_RTMS_GLOBAL_TEAM_ID` | Global app settings | Global OAuth settings |
| Shared customer | Exact customer JSON entry without `rtmsApp` | Global app settings | Customer entry |
| Dedicated customer | Exact customer JSON entry with `rtmsApp` | Customer entry | Customer entry |

Credential selection is fail-closed:

- An enabled exact customer entry uses that customer's S2S OAuth credentials and either the shared or its dedicated RTMS app.
- The exact `ZOOM_RTMS_GLOBAL_TEAM_ID` uses the global/internal OAuth credentials.
- Disabled, invalid, and unknown teams do not receive global credentials.

`ZOOM_RECORDING_TRANSPORT` is deployment-wide. A single deployment cannot currently use RTMS first for the internal team while using browser first for customers. That requires a future per-team transport policy or separate deployments.

`teamId` is a routing key, not proof of tenant ownership. The credential resolver assumes that the job producer already authenticated the caller and verified that the caller belongs to that team. Restrict the HTTP endpoint and Redis queue to trusted producers, validate bearer-token-to-team membership upstream, and never authorize RTMS from an unverified client-supplied `teamId`.

## Common Zoom prerequisites

Every shared or dedicated Zoom General app must have RTMS enabled. Configure:

- `meeting:read:meeting_audio`
- `meeting:read:meeting_video`
- `meeting.rtms_started`
- `meeting.rtms_stopped`
- `meeting.rtms_interrupted`
- A public HTTPS event endpoint. The shared app uses `/zoom/rtms/webhook`; a dedicated app uses `/zoom/rtms/webhook/apps/<webhookId>`.

The app must have Zoom Developer Pack credits and the Zoom account must allow apps to access shared real-time meeting content. In staging and production, run the meeting bot with `REDIS_CONSUMER_ENABLED=true` so webhook events reach the correct replica.

The following global app credentials are required for the internal and shared-customer profiles:

```env
ZOOM_RTMS_CLIENT_ID=general-app-client-id
ZOOM_RTMS_CLIENT_SECRET=general-app-client-secret
ZOOM_RTMS_WEBHOOK_SECRET=general-app-webhook-secret
```

They belong to the shared RTMS General app and are used to verify webhooks and connect to RTMS media servers. A complete customer `rtmsApp` replaces them only for that exact customer.

## Mode A: internal private app

A private General app can be used without Marketplace publication by users in its own Zoom account. This is different from an unlisted app: an unlisted production app still completes Zoom review before external distribution.

Create a Server-to-Server OAuth app in the same internal Zoom account with:

- `meeting:update:participant_rtms_app_status`, or
- `meeting:update:participant_rtms_app_status:admin`

Configure the internal Winkk team and the account-level OAuth credentials:

```env
ZOOM_RECORDING_TRANSPORT=rtms
ZOOM_RTMS_GLOBAL_TEAM_ID=internal-winkk-team-id
ZOOM_RTMS_OAUTH_ACCOUNT_ID=internal-zoom-account-id
ZOOM_RTMS_OAUTH_CLIENT_ID=internal-s2s-client-id
ZOOM_RTMS_OAUTH_CLIENT_SECRET=internal-s2s-client-secret
ZOOM_RTMS_PARTICIPANT_USER_ID=internal-zoom-user-id
```

Every Zoom job still contains a Winkk `teamId`. Only a job whose `teamId` exactly matches `ZOOM_RTMS_GLOBAL_TEAM_ID` can use these credentials. No customer JSON entry is required for that internal team.

For a short local test, `ZOOM_RTMS_OAUTH_ACCESS_TOKEN` can replace the account ID, client ID, and client secret. Do not store an expiring access token in production.

## Mode B: shared app with multiple customers

External customers must be able to authorize the shared RTMS General app. Use either:

- a Zoom-approved Beta authorization URL for limited testing, or
- a published or unlisted production app after Zoom review.

A private app cannot be shared with a different Zoom account.

Each customer currently creates a private Server-to-Server OAuth app in their own Zoom account and grants:

```text
meeting:update:participant_rtms_app_status:admin
```

Collect these values through an approved secret-sharing channel:

- Zoom account ID
- S2S client ID
- S2S client secret
- Zoom user ID of the participant or host used for RTMS
- Exact Winkk `teamId`

Do not accept credentials in chat, email, screenshots, tickets, or source control.

Add the customer to `ZOOM_RTMS_CUSTOMER_CREDENTIALS_JSON`:

```json
{
  "customer-team-id": {
    "enabled": true,
    "accountId": "zoom-account-id",
    "clientId": "zoom-s2s-client-id",
    "clientSecret": "zoom-s2s-client-secret",
    "participantUserId": "zoom-user-id"
  }
}
```

The outer key is the Winkk `teamId`. `participantUserId` is the Zoom user ID, not an email address. All values are required.

For browser-first customer fallback:

```env
ZOOM_RECORDING_TRANSPORT=browser
ZOOM_RTMS_FALLBACK_ENABLED=true
ZOOM_RTMS_CUSTOMER_CREDENTIAL_MODE=shared_customer
ZOOM_RTMS_CUSTOMER_CREDENTIALS_JSON={...}
```

Only an explicit Zoom automated-bot block before browser admission triggers RTMS. Host rejection, sign-in requirements, lobby timeout, browser failure, and recording failure do not trigger the fallback.

For RTMS first, set `ZOOM_RECORDING_TRANSPORT=rtms`. Enabled exact customer mappings and the exact internal team remain eligible; all other teams fail closed.

## Mode C: dedicated private app per customer

Use this mode when each customer creates and pays for its own private Zoom General RTMS app and S2S OAuth app. The app stays local to that customer's Zoom account and does not depend on publication of the shared Winkk app.

### Customer setup

Complete these steps while signed in to the Zoom account that will own and pay for the RTMS usage. Repeat the complete setup for every customer account and for every environment that needs separate credentials.

#### 1. Create the private General RTMS app

1. Open [Build an app in Zoom App Marketplace](https://marketplace.zoom.us/develop/create), select **General App**, and create the app. Zoom's detailed instructions are in [Create an OAuth app](https://developers.zoom.us/docs/integrations/create/).
2. Name it for the owning account, for example `winkk AI Notetaker - Customer Name`.
3. Under **Basic Information**, select **User-managed**. Zoom requires an RTMS app to be user-managed.
4. Keep the app private: do not submit it for Marketplace publication. For an unpublished same-account app, use the **Development** credentials and install it from **Local Test** with **Add App Now**, then **Allow**. Local-test access is limited to members of that Zoom account.
5. Under **Access**, enable **Event Subscription** and add exactly these meeting events:
   - `meeting.rtms_started`
   - `meeting.rtms_stopped`
   - `meeting.rtms_interrupted`
6. Set the event notification endpoint to one unique dedicated webhook URL:

   ```text
   Production: https://rtms.winkk.ai/zoom/rtms/webhook/apps/<webhookId>
   Development: https://dev.rtms.winkk.ai/zoom/rtms/webhook/apps/<webhookId>
   ```

   Choose `<webhookId>` once for this customer and environment. It may contain only letters, numbers, `_`, and `-`, must be unique across all customer entries, and must not be `global`. Zoom validates this public HTTPS endpoint when the subscription is saved.
7. Under **Scopes**, add:
   - `meeting:read:meeting_audio`
   - `meeting:read:meeting_video`
8. Copy the following values without posting them in chat or source control:
   - **Client ID** from the General app's Development credentials
   - **Client Secret** from the same credential set
   - **Secret Token** from **Access**; this is the webhook secret and is not the Client Secret

See [Add Realtime Media Streams to your app](https://developers.zoom.us/docs/rtms/meetings/add-features/) for Zoom's current RTMS event, scope, and user-managed-app requirements.

#### 2. Create the private Server-to-Server OAuth control app

1. Open [Build an app in Zoom App Marketplace](https://marketplace.zoom.us/develop/create), select **Server-to-Server OAuth App**, and create it. Follow Zoom's [Server-to-Server OAuth app guide](https://developers.zoom.us/docs/internal-apps/create/).
2. Name it for the owning account, for example `winkk AI Notetaker Control - Customer Name`.
3. Complete the required app information.
4. Add exactly this required granular scope:

   ```text
   meeting:update:participant_rtms_app_status:admin
   ```

   If the onboarding process must look up the participant's Zoom user ID from their email, also add `user:read:user:admin` and use Zoom's [Get a user API](https://developers.zoom.us/docs/api/users/#tag/users/GET/users/{userId}). It is not required by the meeting bot after `participantUserId` is known.
5. Activate the S2S app. Zoom does not issue usable account-credential tokens while it is inactive.
6. Copy its **Account ID**, **Client ID**, and **Client Secret**.

The S2S app does not need an event subscription. It only obtains a short-lived account token and calls Zoom's [participant RTMS status API](https://developers.zoom.us/docs/api/meetings/#tag/meetings/PATCH/live_meetings/{meetingId}/rtms_app/status).

#### 3. Enable RTMS for the Zoom account

As a Zoom account admin, enable **Share realtime meeting content with apps**, then add the dedicated General app's Client ID under **Allow apps to access meeting content**. The meeting bot starts RTMS through the REST API, so Zoom's auto-start setting is optional. The account also needs Zoom Developer Pack credits. Zoom documents these prerequisites and settings in [Getting started with RTMS](https://developers.zoom.us/docs/rtms/meetings/getting-started/) and the [participant RTMS status API](https://developers.zoom.us/docs/api/meetings/#tag/meetings/PATCH/live_meetings/{meetingId}/rtms_app/status).

#### 4. Map the customer to its exact Winkk team

Obtain the exact Winkk `teamId` from the authenticated meeting job and the Zoom `id` of the user whose meeting participation authorizes RTMS. The Zoom user ID is the `id` returned by Zoom's Get a user API; it is not an email address, meeting ID, account ID, or Winkk team ID.

Map the values as follows:

| Zoom/Winkk source | Customer JSON field |
| --- | --- |
| Exact Winkk team ID | Outer JSON key |
| S2S Account ID | `accountId` |
| S2S Client ID | `clientId` |
| S2S Client Secret | `clientSecret` |
| Zoom user's `id` | `participantUserId` |
| Chosen unique webhook identifier | `rtmsApp.webhookId` |
| General app Client ID | `rtmsApp.clientId` |
| General app Client Secret | `rtmsApp.clientSecret` |
| General app Access Secret Token | `rtmsApp.webhookSecret` |

Add the customer's S2S settings plus a complete `rtmsApp` object:

```json
{
  "customer-team-id": {
    "enabled": true,
    "accountId": "zoom-account-id",
    "clientId": "zoom-s2s-client-id",
    "clientSecret": "zoom-s2s-client-secret",
    "participantUserId": "zoom-user-id",
    "rtmsApp": {
      "webhookId": "customer-app-unique-id",
      "clientId": "zoom-general-app-client-id",
      "clientSecret": "zoom-general-app-client-secret",
      "webhookSecret": "zoom-general-app-webhook-secret"
    }
  }
}
```

Multiple dedicated accounts are stored in the same environment variable, keyed by their exact and distinct Winkk team IDs:

```json
{
  "winkk-team-id": {
    "enabled": true,
    "accountId": "winkk-zoom-account-id",
    "clientId": "winkk-s2s-client-id",
    "clientSecret": "winkk-s2s-client-secret",
    "participantUserId": "winkk-zoom-user-id",
    "rtmsApp": {
      "webhookId": "winkk-prod",
      "clientId": "winkk-general-app-client-id",
      "clientSecret": "winkk-general-app-client-secret",
      "webhookSecret": "winkk-general-app-secret-token"
    }
  },
  "customer-team-id": {
    "enabled": true,
    "accountId": "customer-zoom-account-id",
    "clientId": "customer-s2s-client-id",
    "clientSecret": "customer-s2s-client-secret",
    "participantUserId": "customer-zoom-user-id",
    "rtmsApp": {
      "webhookId": "customer-prod",
      "clientId": "customer-general-app-client-id",
      "clientSecret": "customer-general-app-client-secret",
      "webhookSecret": "customer-general-app-secret-token"
    }
  }
}
```

`webhookId` may contain letters, numbers, `_`, and `-`; it must be unique and must not be `global`. Dedicated app settings are all-or-nothing. Invalid, partial, duplicated, disabled, and unknown entries fail closed and never inherit another app.

Store the complete JSON as the single secret environment variable `ZOOM_RTMS_CUSTOMER_CREDENTIALS_JSON`. With the current browser-first deployment, the non-secret transport settings are:

```env
ZOOM_RECORDING_TRANSPORT=browser
ZOOM_RTMS_FALLBACK_ENABLED=true
ZOOM_RTMS_CUSTOMER_CREDENTIAL_MODE=dedicated_customer
```

Store `ZOOM_RTMS_CUSTOMER_CREDENTIAL_MODE` in the same 1Password item as the customer JSON. Dedicated mode rejects customer entries without a complete `rtmsApp`, preventing an accidental fallback to the shared Winkk General app. Global `ZOOM_RTMS_*` app and OAuth values are not used for an enabled dedicated entry with `rtmsApp`; they may coexist only for the separate internal/shared profiles. After updating the secret, restart the process or let the 1Password operator restart the pods, then verify one controlled meeting for each exact team ID.

## Customer onboarding checklist

1. Confirm the customer's exact Winkk `teamId` from the job payload.
2. For Mode B, ensure the shared Winkk General app is approved for external authorization. For Mode C, activate the customer's private General app.
3. For Mode B, have the customer admin authorize the shared Winkk app. For Mode C, have the customer activate its own app.
4. Enable shared real-time meeting content in the customer's Zoom account settings.
5. Have the customer create and activate their S2S OAuth app with the required admin scope; for Mode C, also collect the dedicated General-app values and unique webhook ID.
6. Obtain the account ID, client ID, client secret, and Zoom participant user ID securely.
7. Add an enabled exact entry to the customer JSON in the correct environment.
8. Restart the process or pods so the environment is reloaded.
9. Start a controlled meeting and verify the webhook, stream connection, finalization, and upload.

## Own and external meetings

| Scenario | Browser | RTMS REST start |
| --- | --- | --- |
| Customer hosts the meeting | Can join as a visible guest | Supported when the app and user are authorized |
| Customer is invited to an external meeting and has joined | Can join as a visible guest | Supported subject to host policy and approval |
| Customer only received a shared public link | Can attempt a visible guest join | The link alone is insufficient |
| Customer is the actual host but has not joined | Can attempt a visible guest join | May start before the host only when Zoom's Join Before Host setting permits it |
| Customer is an alternate host or invited participant but has not joined | Can attempt a visible guest join | Unavailable until that authorized user joins |

For an external meeting, an authorized alternate host or invited participant must have joined; the meeting host or a designated alternate host must also be present. The actual host is the exception: Zoom can permit RTMS before the host joins when Join Before Host is enabled. The meeting host can allow, require approval for, or reject RTMS access.

An in-meeting Zoom App can also call `startRTMS()` after the user opens it and the host approves. That in-meeting UI is not implemented in this repository.

## Dev, production, and 1Password

Use separate Zoom development and production credentials and separate 1Password vault items.

Production RTMS workloads must run on `linux/amd64`. The Zoom RTMS SDK rejects Linux ARM64 even if a multi-architecture meeting-bot image is available; pin RTMS-capable pods to x86-64 nodes.

Recommended items:

- `Meeting Bot App Secrets`: shared General app credentials, internal S2S credentials, Sentry, and other application secrets.
- `Meeting Bot Customer RTMS Credentials`: `ZOOM_RTMS_CUSTOMER_CREDENTIAL_MODE` and `ZOOM_RTMS_CUSTOMER_CREDENTIALS_JSON`.

The automatically generated 1Password `Password` field is not used by the meeting bot. The internal team ID and transport flags are not secrets and can live in the deployment configuration.

Configure a separate public HTTPS `/zoom/rtms/webhook` endpoint for each environment. Dedicated apps append `/apps/<webhookId>`. Verify the rendered URL against the current infrastructure before entering it in Zoom.

After changing a secret, confirm that the 1Password operator updated the Kubernetes Secret and restarted the meeting-bot pods. Never print secret values while checking the deployment.

## Rotation and offboarding

- Rotate a client secret immediately if it appears in chat, a screenshot, a log, or source control.
- Update every environment that uses the credential.
- Set a customer entry to `enabled: false` to revoke RTMS for that team, then restart the pods.
- Remove the entry after the retention period required by the operating process.
- When a customer is offboarded, have that customer remove its installation of the shared General app from its Zoom account. Do not disable the shared app globally while other tenants use it.

Disabled and invalid customer entries never fall back to internal credentials.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Missing credentials for a team | Exact job `teamId`, spelling, JSON key, and `enabled` |
| Invalid customer configuration | JSON syntax, all required strings, and a complete unique `rtmsApp` when dedicated |
| OAuth token request fails | Customer account ID, S2S client ID, secret, activation, and scopes |
| Zoom code `3000` | Meeting has not started; the bot retries until the join deadline |
| Zoom code `2308` or `2309` | Participant role or external-host authorization; customer credentials wait for approval, while global/internal credentials fail immediately |
| Zoom code `2310` | RTMS entitlement, app authorization, account setting, meeting state, and scope |
| Zoom code `2312` | `participantUserId` is incorrect |
| Zoom code `13262` | The General app client ID is missing from Zoom's "Allow apps to access meeting content" setting |
| Zoom code `13267` | RTMS app access is disabled in Zoom settings |
| Zoom code `13273` | The meeting does not support RTMS |
| No fresh start event | Correct shared/dedicated webhook URL, webhook secret, event subscriptions, Redis, and operator ID |
| SDK unavailable | Run RTMS on Linux x64 or macOS arm64 |
| Duplicate recording rejected | Another stream is already reserved for the meeting and operator |

The meeting bot waits up to `JOIN_WAIT_TIME_MINUTES` for initial authorization and a fresh `meeting.rtms_started` event.

## Current product boundary

Customer onboarding is manual and team-scoped. The repository does not yet implement:

- a Zoom OAuth authorization-code callback,
- encrypted refresh-token storage per customer,
- a self-service "Connect Zoom" flow,
- per-user RTMS enablement within one Winkk team,
- per-team primary transport selection, or
- an in-meeting `startRTMS()` Zoom App interface.

For self-service onboarding, use a reviewed shared General app and store OAuth grants dynamically per Winkk team instead of collecting customer S2S secrets.

## Zoom references

- [Add Realtime Media Streams to your app](https://developers.zoom.us/docs/rtms/meetings/add-features/)
- [Work with RTMS streams](https://developers.zoom.us/docs/rtms/meetings/work-with-streams/)
- [Zoom OAuth 2.0](https://developers.zoom.us/docs/integrations/oauth/)
- [Zoom app distribution](https://developers.zoom.us/docs/distribute/)
- [Sharing private and Beta apps](https://developers.zoom.us/docs/distribute/sharing-private-and-beta-apps/)
