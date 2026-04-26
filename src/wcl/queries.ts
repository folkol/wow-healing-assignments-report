export const Q_GUILD_REPORTS = /* GraphQL */ `
  query GuildReports(
    $name: String!
    $serverSlug: String!
    $serverRegion: String!
    $startTime: Float
    $endTime: Float
    $limit: Int = 25
    $page: Int = 1
  ) {
    reportData {
      reports(
        guildName: $name
        guildServerSlug: $serverSlug
        guildServerRegion: $serverRegion
        startTime: $startTime
        endTime: $endTime
        limit: $limit
        page: $page
      ) {
        total
        per_page
        current_page
        has_more_pages
        data {
          code
          title
          startTime
          endTime
          zone {
            id
            name
          }
          owner {
            name
          }
        }
      }
    }
  }
`;

export const Q_REPORT_META = /* GraphQL */ `
  query ReportMeta($code: String!) {
    reportData {
      report(code: $code) {
        code
        title
        startTime
        endTime
        zone {
          id
          name
        }
        fights(translate: true) {
          id
          name
          encounterID
          difficulty
          kill
          startTime
          endTime
          fightPercentage
          bossPercentage
          lastPhase
          lastPhaseAsAbsoluteIndex
          size
          averageItemLevel
        }
        masterData {
          actors(type: "Player") {
            id
            name
            type
            subType
            server
          }
          abilities {
            gameID
            name
            icon
            type
          }
        }
      }
    }
  }
`;

export const Q_REPORT_EVENTS = /* GraphQL */ `
  query ReportEvents(
    $code: String!
    $startTime: Float!
    $endTime: Float!
    $fightIDs: [Int]
    $dataType: EventDataType
    $hostilityType: HostilityType
    $sourceID: Int
    $targetID: Int
    $abilityID: Float
    $filterExpression: String
    $includeResources: Boolean
    $limit: Int = 10000
  ) {
    reportData {
      report(code: $code) {
        events(
          startTime: $startTime
          endTime: $endTime
          fightIDs: $fightIDs
          dataType: $dataType
          hostilityType: $hostilityType
          sourceID: $sourceID
          targetID: $targetID
          abilityID: $abilityID
          filterExpression: $filterExpression
          includeResources: $includeResources
          limit: $limit
        ) {
          data
          nextPageTimestamp
        }
      }
    }
  }
`;
