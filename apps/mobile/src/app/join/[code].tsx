// Pre-filled join screen reached from an `outthegc://join/<code>` deep link
// (or an in-app `Link href={`/join/${code}`}`). Re-exports the same
// component `/join` renders — see the comment on `JoinTripScreen` in
// `src/app/join.tsx` for why one component safely serves both routes.
export { default } from '@/app/join';
