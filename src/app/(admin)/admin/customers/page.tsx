import { redirect } from 'next/navigation';

/**
 * Block 16, D6. What used to be the customers console.
 *
 * The screen is gone — it listed STATIONS and called them customers, which is
 * the confusion this block existed to end. The address stays, because a platform
 * admin has had it bookmarked since Block 1c and a 404 is a worse answer than
 * the screen that replaced it.
 *
 * It lands on Organizations rather than Stations: "customers" meant the people
 * who pay, and that is now the group. Somebody who wanted a radio is one click
 * away, and the Stations tab of every group's record links straight there.
 */
export default function RetiredCustomersPage() {
  redirect('/admin/organizations');
}
