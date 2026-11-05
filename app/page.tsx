import ChatInterface from '@/components/ChatInterface';

/**
 * The assistant opens straight into the chat: there is no login, by design.
 * Salesforce authentication happens once, server-side, for one dedicated user.
 */
export default function Home() {
  return (
    <main className="h-full">
      <ChatInterface appName={process.env.NEXT_PUBLIC_APP_NAME ?? 'Salesforce AI Sales Assistant'} />
    </main>
  );
}
