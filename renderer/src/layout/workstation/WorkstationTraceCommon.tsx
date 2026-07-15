import { Stack, Text } from '@mantine/core'

export function EmptyState({
  icon,
  title,
  detail
}: {
  icon: React.ReactNode
  title: string
  detail?: string
}) {
  return (
    <Stack align="center" gap={8} py={42} px="lg" style={{ color: 'var(--mantine-color-dimmed)' }}>
      {icon}
      <Text size="13px" fw={600} c="dimmed" ta="center">
        {title}
      </Text>
      {detail && (
        <Text size="11.5px" c="dimmed" ta="center" style={{ maxWidth: 280, lineHeight: 1.5 }}>
          {detail}
        </Text>
      )}
    </Stack>
  )
}
