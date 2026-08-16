/**
 * Block 10a. What an action code is called, for people.
 *
 * A LOOKUP WITH A FALLBACK, AND NOT A RENDERER PER ACTION. The alternative was
 * turning each row's `detail` into a sentence, which reads better and rots
 * silently: an action added by a later block gets no branch and renders as
 * nothing, which in an audit viewer is indistinguishable from an event that
 * carried no detail. Here an unmapped code renders as `winners.reopen_deadline`
 * — ugly, honest, and self-announcing.
 *
 * `detail` itself is never summarised anywhere. Summarising is where an audit
 * viewer would start lying.
 *
 * This map is a convenience over the codes in the migrations, not a second
 * source of truth: nothing reads it to decide anything, and a code missing from
 * it costs legibility rather than correctness.
 */
const ACTION_LABELS: Record<string, string> = {
  accept_invitation: 'Invitation accepted',
  add_company: 'Station added',
  anonymize_member: 'Listener erased',
  archive_member: 'Listener archived',
  archive_message_template: 'Message template archived',
  archive_music_request: 'Music request archived',
  archive_prize: 'Prize archived',
  // Block 26. Its `detail` is empty, and can be: the door refuses while any live
  // prize still wears the label, so an entry here means the category was already
  // unused and there is no count to record. The prizes that were moved off it
  // beforehand have update_prize entries of their own, each carrying its own
  // before/after.
  archive_prize_category: 'Prize category archived',
  archive_promotion: 'Promotion archived',
  archive_song: 'Song archived',
  assign_company_role: 'Role assigned at a Station',
  cancel_promotion: 'Promotion cancelled',
  change_member_role: 'Member role changed',
  change_org_role: 'Organization role changed',
  configure_integration: 'WhatsApp integration configured',
  create_invitation: 'Invitation created',
  create_member: 'Listener registered',
  create_music_request: 'Music request recorded',
  create_prize: 'Prize created',
  create_promotion: 'Promotion created',
  create_role: 'Role created',
  create_song: 'Song created',
  delete_role: 'Role deleted',
  disable_integration: 'WhatsApp integration disabled',
  inventory_movement: 'Stock movement',
  provision_customer: 'Customer provisioned',
  reactivate_company: 'Station reactivated',
  record_participation: 'Participation recorded',
  register_message_template: 'Message template registered',
  remove_company_access: 'Station access removed',
  remove_member: 'Member removed',
  request_report: 'Report exported',
  reset_provisional_password: 'Provisional password reset',
  revoke_invitation: 'Invitation revoked',
  // Block 26. One code for both registering and renaming, because 0202 is one
  // door: its `detail` carries `created`, which says which of the two happened.
  save_prize_category: 'Prize category saved',
  suspend_company: 'Station suspended',
  update_member: 'Listener updated',
  update_prize: 'Prize updated',
  update_promotion: 'Promotion updated',
  update_role: 'Role updated',
  update_song: 'Song updated',
  winner_transition: 'Winner status changed',
};

export function actionLabel(code: string): string {
  return ACTION_LABELS[code] ?? code;
}

/**
 * Who did it.
 *
 * THE ONE RULE THIS FUNCTION EXISTS FOR, and 0096 paid for it once already:
 * `actor_name` is `profiles.full_name`, which is **nullable**, so a null name
 * does NOT mean the system acted — it equally means a real operator who never
 * set a display name. Only a null `actor_id` means the clock.
 *
 * A screen that keyed "(system)" off the name would label real people the
 * system, in the one place where being wrong about who did something matters
 * most.
 */
export function actorLabel(row: {
  actor_id: string | null;
  actor_name: string | null;
}): string {
  if (row.actor_id === null) return '(system)';
  // A real person with no display name. The id is not friendly and it is true,
  // and it resolves to exactly one account — which an empty cell would not.
  return row.actor_name ?? row.actor_id;
}
