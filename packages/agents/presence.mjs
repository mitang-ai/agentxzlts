export async function participantPresence(pool, participants, roomId) {
  const { rows } = await pool.query(
    `select p.id,
    case when p.type='human' then exists(select 1 from realtime_connections c
      where c.user_id=p.user_id and c.room_id=p.room_id and c.last_seen_at>now()-interval '20 seconds')
    else exists(select 1 from agent_seats s join agent_nodes n on n.id=s.node_id
      where s.participant_id=p.id and s.state='approved' and n.revoked_at is null
      and (not n.platform_scope or n.active_seat_id=s.participant_id)
      and n.expires_at>now() and n.session_id is not null and n.last_seen_at>now()-interval '45 seconds'
      and n.ready_until>now() and not s.muted) end online
    from participants p where p.room_id=$1 and p.status='active'`,
    [roomId],
  );
  const states = new Map(rows.map((row) => [row.id, row.online]));
  return participants.map((p) => ({ ...p, online: states.get(p.id) === true }));
}
