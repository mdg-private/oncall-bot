This bot maintains a single Slack channel's topic to contain the name of the
level-1 on-call user for a given PagerDuty schedule ID.

Create a settings.json file like:

```
{
  "pagerduty": {
    "primaryScheduleID": "ID",
    "secondaryScheduleID": "ID",
    "pagerdutyToken": "TOKEN"
  },
  "slack": {
    "channelNames": ["engine-alerts", "engine-alerts-discuss"],
    "slackToken": "TOKEN1",
    "slackAdminToken": "TOKEN2"
  },
  "intervalMS": 30000,
  "statusUsers": {
    "U02FWGZ19": "glasser@meteor.com"
  },
}
```

- In PagerDuty
  - Log in as an Admin-role user
  - Configuration -> API Access
  - Create New API Key
  - Make it a V2 Current token, Read-only.
  - Copy the token value into the pagerduty.pagerdutyToken settings field
  - Navigate to the page for the schedule(s) you want to monitor. Its URL is
    something like https://meteorjs.pagerduty.com/schedules#PTJS3I9
    Copy the final bit (`PTJS3I9`) to the pagerduty.${level}ScheduleID settings field
- In Slack
  - Register an app at https://api.slack.com/apps
  - Select Permissions and add:
    - `channels:read`
    - `channels:write`
    - `users:read`
  - Click "Install App To Team" and select the appropriate team
  - This provides an Access Token. Copy it into the slack.slackToken settings field
  - Now get a Slack team admin to follow the same steps, but with only the
    permission `users.profile:write`. Put its Access Token into
    slack.slackAdminToken. This is used to set the status emoji and text for
    arbitrary users.

Users listed (by Slack ID) in the status section will have their status text and
emoji set as configured when they are on call, and cleared if they are not on
call any more and their status starts with 'On call!'.  (If they already have a
status, it is appended to the 'On call!' status text along with its emoji, and
restored when they go off call.)

The simplest way to find a Slack ID is to run users.list via
the [Slack API tester](https://api.slack.com/methods/users.list/test) and find
the id field corresponding to the user.

Deploy to Galaxy.  (This is deployed to galaxy-primary-oncall-bot.meteorapp.com.)
