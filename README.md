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
  "intervalMS": 30000,
  "status": {
    "text": "On call (set automatically)",
    "emoji": ":pagerduty:",
    "users": {
      "U02FWGZ19": "glasser@meteor.com"
    }
  },
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
  - You must be a team admin in order to set the status of other users!
  - Register an app at https://api.slack.com/apps
  - Select Permissions and add:
    - `channels:read`
    - `channels:write`
    - `users:read`
    - `users.profile:write`
  - Click "Install App To Team" and select the appropriate team
  - This provides an Access Token. Copy it into the slack.slackToken settings field

Users listed (by Slack ID) in the status section will have their status text and
emoji set as configured when they are on call, and cleared (to empty --- there's
no state) if they are not on call any more and their status matches the one that
the bot sets.

The simplest way to find a Slack ID is to run users.list via
the [Slack API tester](https://api.slack.com/methods/users.list/test) and find
the id field corresponding to the user.

Deploy to Galaxy.  (This is deployed to galaxy-primary-oncall-bot.meteorapp.com.)
