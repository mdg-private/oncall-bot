This bot maintains a single Slack channel's topic to contain the name of the
level-1 on-call user for a given PagerDuty schedule ID.

Create a settings.json file like:

```
{
  "pagerduty": {
    "scheduleID": "ID",
    "pagerdutyToken": "TOKEN"
  },
  "slack": {
    "channelName": "galaxy-alerts",
    "slackToken": "TOKEN"
  },
  "intervalMS": 30000
}
```

- In PagerDuty
  - Log in as an Admin-role user
  - Configuration -> API Access
  - Create New API Key
  - Make it a V2 Current token, Read-only.
  - Copy the token value into the pagerduty.pagerdutyToken settings field
  - Navigate to the page for the schedule you want to monitor. Its URL is
    something like https://meteorjs.pagerduty.com/schedules#PTJS3I9
    Copy the final bit (`PTJS3I9`) to the pagerduty.scheduleID settings field
- In Slack
  - Register an app at https://api.slack.com/apps
  - Select Permissions and add `channels:read` and `channels:write` permissions
  - Click "Install App To Team" and select the appropriate team
  - This provides an Access Token. Copy it into the slack.slackToken settings field

Deploy to Galaxy.  (This is deployed to galaxy-primary-oncall-bot.meteorapp.com.)
