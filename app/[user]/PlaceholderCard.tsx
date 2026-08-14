import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PLACEHOLDER_CARD } from '@/lib/copy/onboarding'

/**
 * What occupies the content area until a dashboard is deployed.
 *
 * STATIC UI CHROME, NOT AN AGENT MESSAGE — onboarding-ux-spec.md is explicit
 * about that, and it matters: an agent message would live in the transcript
 * and scroll away, and this has to still be there tomorrow morning.
 *
 * "You'll hear from the chat when your app is live" points at the
 * operator-authored go-live message (lib/chat/announce.ts). The agent never
 * announces its own deploy — that is the standing rule the announce command
 * exists to enforce.
 *
 * NO TIME OF DAY, anywhere. The spec: "Any delivery-time wording anywhere in
 * UI chrome must read from the same two constants as the agent's delivery line
 * — never hardcode a time of day." This block reads from neither, so it
 * promises neither, and tests/copy/onboarding.test.ts fails if a timeframe
 * ever appears in it.
 */
export function PlaceholderCard() {
  return (
    <Card className="mx-auto max-w-[560px]">
      <CardHeader>
        <CardTitle>{PLACEHOLDER_CARD.heading}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {PLACEHOLDER_CARD.body}
        </p>
      </CardContent>
    </Card>
  )
}
