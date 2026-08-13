import { Banner, Text, VStack, useUiLocale } from '@maka/ui';
import { getProviderSettingsCopy } from '../locales/settings-provider-copy';

/**
 * Retired Claude subscription card.
 *
 * The card stays in the catalog rather than disappearing: a workspace that
 * signed in before still has that connection listed, and a row that vanishes
 * leaves the user to discover on their own why their model stopped working.
 * This says what happened and where to go instead.
 */
export function ClaudeSubscriptionCard() {
  const locale = useUiLocale();
  const copy = getProviderSettingsCopy(locale).oauthSection;
  return (
    <VStack gap={3}>
      <Banner
        status="info"
        title={copy.claudeRetiredTitle}
        description={copy.claudeRetiredBody}
      />
      <Text>{copy.claudeRetiredAction}</Text>
    </VStack>
  );
}
