import { HttpError } from '../authz.js';
import { env } from '../env.js';

/**
 * Email is a driver like storage and the database, so invites work end to end
 * before you have a provider account.
 *
 * The `console` driver prints the link and returns it to the caller, which lets
 * you develop and test the whole invite flow offline. In production it is
 * allowed to exist but refuses to send, because a live invite link sitting in a
 * server log is a credential anyone with log access can redeem.
 */
export interface SentEmail {
  delivered: boolean;
  /** Present only under the console driver, for local development. */
  previewLink?: string;
}

export async function sendInviteEmail(args: {
  to: string;
  link: string;
  orgName: string;
  inviterName: string;
  roleLabel: string;
}): Promise<SentEmail> {
  /**
   * Refuse at the point of harm rather than at boot. Printing a live invite
   * link into a production log hands account access to anyone who can read
   * logs, so this path stays closed even though the server is allowed to run.
   */
  if (env.isProd && env.EMAIL_DRIVER === 'console') {
    throw new HttpError(
      503,
      'email_not_configured',
      'Email invitations are not configured on this server. Add the person by their account ID instead, or set RESEND_API_KEY to enable invites.',
    );
  }

  if (env.EMAIL_DRIVER === 'console') {
    console.log('');
    console.log('--- INVITE (console email driver) ------------------------');
    console.log(`  To:     ${args.to}`);
    console.log(`  Org:    ${args.orgName} (${args.roleLabel})`);
    console.log(`  From:   ${args.inviterName}`);
    console.log(`  Link:   ${args.link}`);
    console.log('----------------------------------------------------------');
    console.log('');
    return { delivered: false, previewLink: args.link };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: args.to,
      subject: `${args.inviterName} invited you to ${args.orgName} on InspectorOne`,
      text:
        `${args.inviterName} has invited you to join ${args.orgName} as ${args.roleLabel}.\n\n` +
        `Accept the invitation:\n${args.link}\n\n` +
        `This link expires in ${env.INVITE_TTL_DAYS} days.`,
    }),
  });

  if (!res.ok) {
    throw new Error(`Email provider rejected the request: ${res.status}`);
  }
  return { delivered: true };
}
