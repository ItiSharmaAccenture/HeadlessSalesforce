/**
 * The technician the My Day page is rendered for.
 *
 * A demo stand-in for real sign-in: the page and the Copilot API both read it
 * from here, so the browser never chooses whose appointments are fetched or
 * updated.
 */
export const currentTechnician = {
  firstName: 'Sayantan',
  fullName: 'Sayantan Pal',
  role: 'Field Service Technician',
  onDuty: true,
  photo: '/assets/my-day/technician.webp',
} as const;
