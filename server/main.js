import requestPromise from 'request-promise-native';
import promisify from 'es6-promisify';
import moment from 'moment';
import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import slack from 'slack';

var lastOnCallName = null;

check(Meteor.settings, Match.ObjectIncluding({
  pagerduty: {
    scheduleID: String,
    pagerdutyToken: String,
  },
  slack: {
    channelName: String,
    slackToken: String,
    slackAdminToken: String,
  },
  statusUsers: Match.Optional(Object),
  intervalMS: Number
}));

function getOnCall({scheduleID, pagerdutyToken}) {
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
  getOnCall(pagerduty)
    .then(({onCallName, onCallEmail}) => {
      return ensureSlackTopic({onCallName, channelID, slackToken: slack.slackToken})
        .then(() => ensureSlackStatuses({
          onCallEmail,
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

function ensureSlackStatuses({onCallEmail, statusUsers, slackToken,
                              slackAdminToken}) {
  if (!statusUsers) {
    return Promise.resolve(null);
  }
  function setProfile({id, emoji, text}) {
    console.log(`Setting status for ${id} to ${emoji} ${text}`);
    return promisify(slack.users.profile.set)({
      token: slackToken,
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
        const isOnCall = statusUsers[id] === onCallEmail;
        if (isOnCall && (profile.status_emoji !== STATUS_EMOJI ||
                         !profile.status_text.startsWith(STATUS_TEXT))) {
          // On call!  Set their status, perhaps saving their current status at
          // the end of the status text.
          let text = STATUS_TEXT;
          if (profile.status_emoji !== '' || profile.status_text != '') {
            text = `${text} ${profile.status_emoji} ${profile.status_text}`;
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

function getSlackChannelID({channelName, slackToken}) {
  return promisify(slack.channels.list)({token: slackToken})
    .then(data => {
      for (var i = 0; i < data.channels.length; i++) {
        if (data.channels[i].name === channelName) {
          return data.channels[i].id;
        }
      }
      throw new Error(`Slack channel ${ channelName } not found`);
    });
}

function determineSlackChannelIDOrDie({channelName, slackToken}) {
  return getSlackChannelID({channelName, slackToken})
    .then(id => {
      console.log(`Found channel ID ${ id } for #${ channelName }`);
      return id;
    })
    .catch(err => {
      console.error("Could not determine Slack channel ID!");
      console.error(err);
      process.exit(1);
    });
}

function ensureSlackTopic({onCallName, channelID, slackToken}) {
  return promisify(slack.channels.info)({token: slackToken, channel: channelID})
    .then(data => {
      const topic = data.channel.topic.value;
      const newTopic = `On call: ${ onCallName }`;
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
  .then(channelID => updateOnCall({channelID, ...Meteor.settings}));
