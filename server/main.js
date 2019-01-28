import requestPromise from "request-promise-native";
import promisify from "es6-promisify";
import moment from "moment";
import { Meteor } from "meteor/meteor";
import { check, Match } from "meteor/check";
import slack from "slack";

var lastOnCallName = null;

console.log("settings", Meteor.settings);

check(
  Meteor.settings,
  Match.ObjectIncluding({
    pagerduty: {
      schedules: [
        {
          label: String,
          id: String,
          slackUserGroupHandle: Match.Optional(String)
        }
      ],
      pagerdutyToken: String
    },
    slack: {
      channels: [
        {
          name: String,
          pattern: String
        }
      ],
      slackToken: String,
      slackAdminToken: String,
      users: Object,
      combinedUserGroupHandle: Match.Optional(String)
    },
    intervalMS: Number
  })
);

function getAllOnCall(schedules, pagerdutyToken, slackUsers) {
  return Promise.all(
    schedules.map(({ label, id, slackUserGroupHandle }) =>
      getSingleOnCall({
        scheduleLabel: label,
        scheduleID: id,
        slackUserGroupHandle,
        pagerdutyToken,
        slackUsers
      })
    )
  );
}

function getSingleOnCall({
  scheduleLabel,
  scheduleID,
  slackUserGroupHandle,
  pagerdutyToken,
  slackUsers
}) {
  const now = moment();
  return requestPromise({
    uri: `https://api.pagerduty.com/schedules/${scheduleID}/users`,
    qs: {
      since: now.toISOString(),
      until: moment(now)
        .add(1, "seconds")
        .toISOString()
    },
    headers: {
      Accept: "application/vnd.pagerduty+json;version=2",
      Authorization: `Token token=${pagerdutyToken}`
    },
    json: true
  }).then(out => {
    return {
      scheduleLabel,
      slackUserGroupHandle,
      onCallName: out.users[0].name,
      onCallSlackUserID: slackUsers[out.users[0].email]
    };
  });
}

function logAllOnCall(onCalls) {
  console.log(
    onCalls
      .map(({ scheduleLabel, onCallName }) => `${scheduleLabel}: ${onCallName}`)
      .join(", ")
  );
}

function updateOnCall(options) {
  const { channels, intervalMS, pagerduty, slack } = options;
  function repeat() {
    setTimeout(() => updateOnCall(options), intervalMS);
  }
  getAllOnCall(pagerduty.schedules, pagerduty.pagerdutyToken, slack.users)
    .then(onCalls => {
      logAllOnCall(onCalls);
      return ensureSlackTopics({
        onCalls,
        channels,
        slackToken: slack.slackToken
      })
        .then(() =>
          ensureSlackStatuses({
            onCalls,
            slackUsers: slack.users,
            slackToken: slack.slackToken,
            slackAdminToken: slack.slackAdminToken
          })
        )
        .then(() =>
          ensureSlackUserGroups({
            onCalls,
            slackToken: slack.slackToken,
            combinedUserGroupHandle: slack.combinedUserGroupHandle
          })
        );
    })
    .then(repeat)
    .catch(err => {
      console.error("Error in updateOnCall iteration", err);
      repeat();
    });
}

const STATUS_EMOJI = ":pagerduty:";
const STATUS_TEXT = "On call!";
const TOPIC_DELIMITER_EMOJI = ":pagerduty:";

function ensureSlackUserGroups({
  onCalls,
  slackToken,
  combinedUserGroupHandle
}) {
  if (combinedUserGroupHandle) {
    onCalls = [
      ...onCalls,
      {
        scheduleLabel: "Combined",
        slackUserGroupHandle: combinedUserGroupHandle,
        onCallName: onCalls
          .map(({ onCallName }) => onCallName)
          .filter(x => x)
          .sort()
          .join(", "),
        onCallSlackUserID: onCalls
          .map(({ onCallSlackUserID }) => onCallSlackUserID)
          .filter(x => x)
          .sort()
          .join(",")
      }
    ];
  }

  return promisify(slack.usergroups.list)({ token: slackToken }).then(
    ({ usergroups }) => {
      const userGroupInfoByHandle = new Map();
      usergroups.forEach(({ id, handle, name }) =>
        userGroupInfoByHandle.set(handle, { name, id })
      );
      return Promise.all(
        onCalls.map(
          ({
            slackUserGroupHandle,
            onCallName,
            onCallSlackUserID,
            scheduleLabel
          }) => {
            if (!(slackUserGroupHandle && onCallSlackUserID && onCallName)) {
              return;
            }
            const userGroupInfo = userGroupInfoByHandle.get(
              slackUserGroupHandle
            );
            if (!userGroupInfo) {
              return Promise.reject(
                Error(`Unknown user group handle ${slackUserGroupHandle}`)
              );
            }
            const existingName =
              userGroupInfo.name || `Oncall ${scheduleLabel}`;
            const existingNamePrefix = existingName.replace(/\s*\(.*/, "");
            const newName = `${existingNamePrefix} (${onCallName})`;
            return promisify(slack.usergroups.users.list)({
              token: slackToken,
              usergroup: userGroupInfo.id
            }).then(({ users }) => {
              const promises = [];
              if (users.join(",") !== onCallSlackUserID) {
                console.log(
                  `Updating usergroup list ${slackUserGroupHandle} to ${onCallName}`
                );
                promises.push(
                  promisify(slack.usergroups.users.update)({
                    token: slackToken,
                    usergroup: userGroupInfo.id,
                    users: onCallSlackUserID
                  })
                );
              }
              if (newName !== existingName) {
                console.log(
                  `Updating usergroup name ${slackUserGroupHandle} to ${onCallName}`
                );
                promises.push(
                  promisify(slack.usergroups.update)({
                    token: slackToken,
                    usergroup: userGroupInfo.id,
                    name: newName
                  })
                );
              }
              return Promise.all(promises);
            });
          }
        )
      );
    }
  );
}

function ensureSlackStatuses({
  onCalls,
  slackUsers,
  slackToken,
  slackAdminToken
}) {
  function setProfile({ id, emoji, text }) {
    console.log(`Setting status for ${id} to ${emoji} ${text}`);
    return promisify(slack.users.profile.set)({
      token: slackAdminToken,
      profile: JSON.stringify({ status_emoji: emoji, status_text: text }),
      user: id
    });
  }
  return promisify(slack.users.list)({ token: slackToken }).then(
    ({ members }) => {
      var promises = [];
      members.forEach(({ id, profile }) => {
        // Is this one of the users we care about?
        if (!Object.values(slackUsers).includes(id)) {
          return;
        }
        const memberOnCalls = onCalls.filter(
          ({ onCallSlackUserID }) => onCallSlackUserID === id
        );
        if (memberOnCalls.length) {
          // On call!  Set their status, perhaps saving their current status at
          // the end of the status text.
          const labels = memberOnCalls
            .map(({ scheduleLabel }) => scheduleLabel)
            .join(", ");
          let text = `${STATUS_TEXT} (${labels})`;
          if (profile.status_emoji !== STATUS_EMOJI) {
            text = `${text} ${profile.status_emoji} ${profile.status_text}`;
          }
          if (
            profile.status_emoji !== STATUS_EMOJI ||
            profile.status_text !== text
          ) {
            promises.push(setProfile({ id, emoji: STATUS_EMOJI, text }));
          }
        } else if (
          profile.status_emoji === STATUS_EMOJI &&
          profile.status_text.startsWith(STATUS_TEXT)
        ) {
          // Not on call, but has the on-call status set.
          const rest = profile.status_text.substr(STATUS_TEXT.length);
          const m = rest.match(/^ (:[^:\s]+:) (.*)$/);
          if (m) {
            // We found an old status at the end.
            promises.push(setProfile({ id, emoji: m[1], text: m[2] }));
          } else {
            // Just un-set the status.
            promises.push(setProfile({ id, emoji: "", text: "" }));
          }
        }
      });
      return Promise.all(promises);
    }
  );
}

function addSlackChannelIDs({ channels, slackToken }) {
  return promisify(slack.channels.list)({ token: slackToken }).then(data =>
    channels.map(channel => {
      const channelFromSlack = data.channels.find(c => c.name === channel.name);
      if (!channelFromSlack) {
        throw new Error(`No Slack channel found for ${channel.name}`);
      }
      return { id: channelFromSlack.id, ...channel };
    })
  );
}

function determineSlackChannelIDsOrDie({ channels, slackToken }) {
  return addSlackChannelIDs({ channels, slackToken })
    .then(channels => {
      console.log(`Found channel IDs: ${JSON.stringify(channels)}`);
      return channels;
    })
    .catch(err => {
      console.error("Could not determine Slack channel IDs!");
      console.error(err);
      process.exit(1);
    });
}

function ensureSlackTopics({ onCalls, channels, slackToken }) {
  return Promise.all(
    channels.map(channel => ensureSlackTopic({ onCalls, channel, slackToken }))
  );
}

function ensureSlackTopic({ onCalls, channel, slackToken }) {
  const { name, pattern, id } = channel;
  return promisify(slack.channels.info)({
    token: slackToken,
    channel: id
  }).then(data => {
    const topic = data.channel.topic.value;
    let prefix = "";
    if (topic) {
      // Preserve any part of the topic before :pagerduty:
      const delimiter = topic.indexOf(TOPIC_DELIMITER_EMOJI);
      if (delimiter !== -1) {
        prefix = topic.substr(0, delimiter).trimEnd() + " ";
      } else if (topic.trimEnd() !== "") {
        prefix = topic.trimEnd() + " ";
      }
    }
    let newTopic = `${prefix}${TOPIC_DELIMITER_EMOJI} ${pattern}`;
    // Replace tokens like @(Primary) with the primary name.
    onCalls.forEach(({ scheduleLabel, onCallName }) => {
      newTopic = newTopic.replace(`@(${scheduleLabel})`, onCallName);
    });
    if (topic !== newTopic) {
      console.log(`Updating #${name} topic to ${newTopic}`);
      return promisify(slack.channels.setTopic)({
        token: slackToken,
        channel: id,
        topic: newTopic
      });
    }
  });
}

determineSlackChannelIDsOrDie(Meteor.settings.slack).then(channels =>
  updateOnCall({ channels, ...Meteor.settings })
);
