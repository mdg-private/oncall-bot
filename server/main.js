import requestPromise from 'request-promise-native';
import promisify from 'es6-promisify';
import moment from 'moment';
import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import slack from 'slack';

var lastOnCallName = null;

console.log('settings', Meteor.settings);

check(Meteor.settings, Match.ObjectIncluding({
  pagerduty: {
    scheduleID: String,
    primaryScheduleID: String,
    secondaryScheduleID: String,
    pagerdutyToken: String,
  },
  slack: {
    channelNames: [String],
    slackToken: String,
    slackAdminToken: String,
  },
  statusUsers: Match.Optional(Object),
  intervalMS: Number
}));

function getOnCall(scheduleID, pagerdutyToken, primary) {
  const now = moment();
  return requestPromise({
    uri: `https://api.pagerduty.com/schedules/${ scheduleID }/users`,
    qs: {
      since: now.toISOString(),
      until: moment(now).add(1, 'seconds').toISOString(),
    },
    headers: {
      Accept: 'application/vnd.pagerduty+json;version=2',
      Authorization: `Token token=${ pagerdutyToken }`,
    },
    json: true
  }).then(out => {
    return {
      primary,
      onCallName: out.users[0].name,
      onCallEmail: out.users[0].email,
    };
  });
}

function updateOnCall(options) {
  const {channelID, intervalMS, pagerduty, slack, statusUsers} = options;
  function repeat() {
    setTimeout(() => updateOnCall(options), intervalMS);
  }
  getOnCall(pagerduty.primaryScheduleID, pagerduty.pagerdutyToken)
    .then(({onCallName, onCallEmail}) => {
      getOnCall(pagerduty.secondaryScheduleID, pagerduty.pagerdutyToken, {onCallName, onCallEmail})
      .then(({primary, onCallName, onCallEmail}) => {
        const primaryOnCallName = primary.onCallName;
        const primaryOnCallEmail = primary.onCallEmail;
        console.log(`primary: ${primaryOnCallName}, secondary: ${onCallName}`);
        return ensureSlackTopic({
          primaryOnCallName,
          secondaryOnCallName: onCallName,
          channelID,
          slackToken: slack.slackToken})
        .then(() => ensureSlackStatuses({
          primaryOnCallEmail,
          secondaryOnCallEmail: onCallEmail,
          statusUsers,
          slackToken: slack.slackToken,
          slackAdminToken: slack.slackAdminToken,
        }));
      })
    .then(repeat)
    .catch(err => {
      console.error("Error in updateOnCall iteration", err);
      repeat();
    });
  })
}

const STATUS_EMOJI = ':pagerduty:';
const STATUS_TEXT = 'On call!';

function ensureSlackStatuses(
  {primaryOnCallEmail, secondaryOnCallEmail, statusUsers, slackToken,slackAdminToken}) {
    console.log(`Secondary email: ${secondaryOnCallEmail}`);
    console.log(`Primary email: ${primaryOnCallEmail}`);
  if (!statusUsers) {
    return Promise.resolve(null);
  }
  function setProfile({id, emoji, text}) {
    console.log(`Setting status for ${id} to ${emoji} ${text}`);
    return promisify(slack.users.profile.set)({
      token: slackAdminToken,
      profile: JSON.stringify({status_emoji: emoji, status_text: text}),
      user: id,
    });
  }
  return promisify(slack.users.list)({token: slackToken})
    .then(({members}) => {
      var promises = [];
      members.forEach(({id, profile}) => {
        // Is this one of the users we care about?
        if (!statusUsers[id]) {
          return;
        }
        const isOnCall = statusUsers[id] === primaryOnCallEmail || statusUsers[id] === secondaryOnCallEmail;
        if (isOnCall) {
          console.log(`${statusUsers[id]} is on call`);
        }
        if (isOnCall && (profile.status_emoji !== STATUS_EMOJI ||
                         !profile.status_text.startsWith(STATUS_TEXT))) {
          // On call!  Set their status, perhaps saving their current status at
          // the end of the status text.
          const isPrimary = statusUsers[id] === primaryOnCallEmail;
          const primaryOrSecondary = isPrimary ? "(primary)" : "(secondary)"
          let text = `${STATUS_TEXT} ${primaryOrSecondary}`;
          if (profile.status_emoji !== '' || profile.status_text != '') {
            text = `${text} ${profile.status_emoji} ${profile.status_text} ${primaryOrSecondary}`;
          }
          promises.push(
            setProfile({id, emoji: STATUS_EMOJI, text}));
        } else if (!isOnCall && profile.status_emoji === STATUS_EMOJI
                   && profile.status_text.startsWith(STATUS_TEXT)) {
          const rest = profile.status_text.substr(STATUS_TEXT.length);
          const m = rest.match(/^ (:[^:\s]+:) (.*)$/);
          if (m) {
            // We found an old status at the end.
            promises.push(setProfile({id, emoji: m[1], text: m[2]}));
          } else {
            // Just un-set the status.
            promises.push(setProfile({id, emoji: '', text: ''}));
          }
        }
      });
      return Promise.all(promises);
    });
}

function getSlackChannelIDs({channelNames, slackToken}) {
  return promisify(slack.channels.list)({token: slackToken})
    .then(data => {
      let channels = []
      for (var i = 0; i < data.channels.length; i++) {
        if (channelNames.includes(data.channels[i].name)) {
          channels.push(data.channels[i].id);
        }
      }
      return channels;
      throw new Error(`No slack channels found for ${ channelNames }`);
    });
}

function determineSlackChannelIDOrDie({channelNames, slackToken}) {
  return getSlackChannelIDs({channelNames, slackToken})
    .then(ids => {
      console.log(`Found channel IDs ${ ids } for #[${ channelNames }]`);
      return ids;
    })
    .catch(err => {
      console.error("Could not determine Slack channel IDs!");
      console.error(err);
      process.exit(1);
    });
}

function ensureSlackTopic({primaryOnCallName, secondaryOnCallName, channelID, slackToken}) {
  return promisify(slack.channels.info)({token: slackToken, channel: channelID})
    .then(data => {
      const topic = data.channel.topic.value;
      const newTopic = `Primary: ${ primaryOnCallName }, Secondary: ${ secondaryOnCallName }`;
      if (topic !== newTopic) {
        console.log(`Updating channel topic to ${ newTopic }`);
        return promisify(slack.channels.setTopic)({
          token: slackToken,
          channel: channelID,
          topic: newTopic,
        });
      }
    });
}

determineSlackChannelIDOrDie(Meteor.settings.slack)
  .then(channelIDs => {
    for (var i = 0; i < channelIDs.length; i++) {
      const channelID = channelIDs[i]
      console.log("updating on-call")
      updateOnCall({channelID, ...Meteor.settings});
    }
  });

