import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';

/**
 * Renders one page as the app does (React Query + router), at `url` matched against `path`.
 * Failed requests are not retried, so an error reaches the screen at once.
 */
export function renderPage(
  element: ReactElement,
  { path = '/', url = path }: { path?: string; url?: string } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter([{ path, element }], { initialEntries: [url] });
  const user = userEvent.setup();
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { user, ...view };
}
