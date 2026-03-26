'use client';

import { useParams } from 'next/navigation';
import RoleEditor from '@/components/role-editor';

export default function EditRolePage() {
  const { id } = useParams<{ id: string }>();
  return <RoleEditor roleId={id} />;
}
