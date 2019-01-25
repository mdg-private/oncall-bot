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
    schedules: [{
      label: String,
      id: String,
    }],
    pagerdutyToken: String,
  },
  slack: {
    channels: [{
      name: String,
      pattern: String,
    }],
    slackToken: String,
    slackAdminToken: String,
  },
  statusUsers: Match.Optional(Object),
  intervalMS: Number
}));

function getAllOnCall(schedules, pagerdutyToken) {
  return Promise.all(schedules.map(({label, id}) => getSingleOnCall({
    scheduleLabel: label,
    scheduleID: id,
    pagerdutyToken,
  })));
}

function getSingleOnCall({scheduleLabel, scheduleID, pagerdutyToken}) {
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
      scheduleLabel,
      onCallName: out.users[0].name,
      onCallEmail: out.users[0].email,
    };
  });
}

function logAllOnCall(onCalls) {
  console.log(onCalls.map(({scheduleLabel, onCallName}) =>
                          `${scheduleLabel}: ${onCallName}`).join(', '));
}

function updateOnCall(options) {
  const {channels, intervalMS, pagerduty, slack, statusUsers} = options;
  function repeat() {
    setTimeout(() => updateOnCall(options), intervalMS);
  }
  getAllOnCall(pagerduty.schedules, pagerduty.pagerdutyToken)
    .then(onCalls => {
      logAllOnCall(onCalls);
      return ensureSlackTopics({
        onCalls,
        channels,
        slackToken: slack.slackToken})
        .then(() => ensureSlackStatuses({
          onCalls,
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
}

const STATUS_EMOJI = ':pagerduty:';
const STATUS_TEXT = 'On call!';
const TOPIC_DELIMITER_EMOJI = ':pagerduty:';

function ensureSlackStatuses(
  {onCalls, statusUsers, slackToken, slackAdminToken}) {
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
        const memberOnCalls = onCalls.filter(
          ({onCallEmail}) => onCallEmail === statusUsers[id]);
        if (memberOnCalls.length) {
          // On call!  Set their status, perhaps saving their current status at
          // the end of the status text.
          const labels = memberOnCalls.map(({scheduleLabel}) => scheduleLabel)
                .join(', ');
          let text = `${STATUS_TEXT} (${labels})`;
          if (profile.status_emoji !== STATUS_EMOJI) {
            text = `${text} ${profile.status_emoji} ${profile.status_text}`;
          }
          if (profile.status_emoji !== STATUS_EMOJI || profile.status_text !== text) {
            promises.push(
              setProfile({id, emoji: STATUS_EMOJI, text}));
          }
        } else if (profile.status_emoji === STATUS_EMOJI
                   && profile.status_text.startsWith(STATUS_TEXT)) {
          // Not on call, but has the on-call status set.
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

function addSlackChannelIDs({channels, slackToken}) {
  return promisify(slack.channels.list)({token: slackToken})
    .then(data => channels.map(channel => {
      const channelFromSlack = data.channels.find(c => c.name == channel.name);
      if (!channelFromSlack) {
        throw new Error(`No Slack channel found for ${channel.name}`);
      }
      return {id: channelFromSlack.id, ...channel};
    }));
}

function determineSlackChannelIDsOrDie({channels, slackToken}) {
  return addSlackChannelIDs({channels, slackToken})
    .then(channels => {
      console.log(`Found channel IDs: ${ JSON.stringify(channels) }`);
      return channels;
    })
    .catch(err => {
      console.error("Could not determine Slack channel IDs!");
      console.error(err);
      process.exit(1);
    });
}

function ensureSlackTopics({onCalls, channels, slackToken}) {
  return Promise.all(
    channels.map(channel => ensureSlackTopic({onCalls, channel, slackToken})));
}

function ensureSlackTopic({onCalls, channel, slackToken}) {
  const {name, pattern, id} = channel;
  return promisify(slack.channels.info)({token: slackToken, channel: id})
    .then(data => {
      const topic = data.channel.topic.value;
      let prefix = '';
      if (topic) {
        // Preserve any part of the topic before :pagerduty:
        const delimiter = topic.indexOf(TOPIC_DELIMITER_EMOJI);
        if (delimiter !== -1) {
          prefix = topic.substr(0, delimiter).trimEnd() + ' ';
        }
      }
      let newTopic = `${prefix}${TOPIC_DELIMITER_EMOJI} ${pattern}`;
      // Replace tokens like @(Primary) with the primary name.
      onCalls.forEach(({scheduleLabel, onCallName}) => {
        newTopic = newTopic.replace(`@(${scheduleLabel})`, onCallName);
      });
      if (topic !== newTopic) {
        console.log(`Updating #${ name } topic to ${ newTopic }`);
        return promisify(slack.channels.setTopic)({
          token: slackToken,
          channel: id,
          topic: newTopic,
        });
      }
    });
}

determineSlackChannelIDsOrDie(Meteor.settings.slack)
  .then(channels => updateOnCall({channels, ...Meteor.settings}));
