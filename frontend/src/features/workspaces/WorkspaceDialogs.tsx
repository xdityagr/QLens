import { useState, type FormEvent } from "react"
import { useNavigate } from "react-router"
import { Button } from "../../components/Button"
import { Dialog } from "../../components/Dialog"
import { Field } from "../../components/Field"
import { ApiError } from "../../lib/api"
import type { WorkspaceOut } from "../../lib/types"
import { FormError } from "../auth/bits"
import { useCreateWorkspace, useDeleteWorkspace } from "./queries"

export function NewWorkspaceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("")
  const create = useCreateWorkspace()
  const navigate = useNavigate()

  function close() {
    setName("")
    create.reset()
    onClose()
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    create.mutate(name.trim(), {
      onSuccess: (ws) => {
        close()
        navigate(`/w/${ws.id}/import`)
      },
    })
  }

  const err = create.error
  const nameError = err instanceof ApiError && err.code === "workspace_name_taken" ? "You already have a workspace with this name." : null

  return (
    <Dialog
      open={open}
      onClose={close}
      title="New workspace"
      description="A workspace holds one spreadsheet and the database QLens builds from it."
    >
      <form onSubmit={submit} className="flex flex-col gap-5">
        <Field
          label="Name"
          placeholder="Coaching fees"
          autoFocus
          required
          maxLength={80}
          value={name}
          error={nameError}
          onChange={(e) => setName(e.target.value)}
        />
        <FormError message={err && !nameError ? err.message : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim()}>
            Create workspace
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

export function DeleteWorkspaceDialog({ workspace, onClose }: { workspace: WorkspaceOut | null; onClose: () => void }) {
  const del = useDeleteWorkspace()
  function close() {
    del.reset()
    onClose()
  }
  return (
    <Dialog
      open={workspace !== null}
      onClose={close}
      title={`Delete ${workspace?.name ?? "workspace"}?`}
      description="This drops its PostgreSQL schemas: the imported sheet, generated tables and query history. It can't be undone."
    >
      <FormError message={del.error?.message} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="danger"
          loading={del.isPending}
          onClick={() => workspace && del.mutate(workspace.id, { onSuccess: close })}
        >
          Delete workspace
        </Button>
      </div>
    </Dialog>
  )
}
