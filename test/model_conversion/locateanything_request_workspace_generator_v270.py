"""Private request-local routing wrapper; same BPU specs and original generation.

The only changed operation is allocation of zero-padded decoder input arrays.
Every returned input remains checked and is consumed by the existing synchronous
executor before reuse. Workspaces are cleared and discarded in finally, even
when generation fails. This source alone is not whole-model qualification.
"""
import threading
from locateanything_group_input_workspace_v268 import GroupInputWorkspace
from locateanything_official_group_routing_v1 import commit_official_group_arrays
from locateanything_official_family_v1 import OfficialDecoderGroup, OfficialFullDecoder, OfficialFullBpuGenerator


class WorkspaceDecoderGroup(OfficialDecoderGroup):
    def __init__(self, original):
        assert type(original) is OfficialDecoderGroup
        super().__init__(original.start, original.end, original.specs)
        self.workspace = None

    def forward(self, executor, hidden, caches, layout, profile, rope):
        assert profile in self.specs and self.workspace is not None
        if profile == 'prefill':
            assert layout.past_length == 0
        length = 1 if profile == 'ar' else 256
        inputs = self.workspace.prepare(hidden, caches, layout, length, rope)
        outputs = executor.run_ordered(self.specs[profile].key, inputs)
        return commit_official_group_arrays(outputs, caches, layout, length)


class RequestWorkspaceGenerator(OfficialFullBpuGenerator):
    def __init__(self, original):
        assert type(original) is OfficialFullBpuGenerator
        assert type(original.decoder) is OfficialFullDecoder
        decoder = OfficialFullDecoder([WorkspaceDecoderGroup(g) for g in original.decoder.groups])
        super().__init__(original.vision, decoder, original.vocabulary, original.rope,
                         original.image_token_index, original.token_ids)
        assert self.specs == original.specs and self.enabled_modes == original.enabled_modes
        self.active_owner = None
        self.completed_workspace_requests = 0
        self.failed_workspace_requests = 0

    def generate(self, *args, **kwargs):
        assert self.active_owner is None and all(g.workspace is None for g in self.decoder.groups)
        self.active_owner = threading.get_ident()
        workspaces = []
        succeeded = False
        try:
            for group in self.decoder.groups:
                group.workspace = GroupInputWorkspace()
                workspaces.append(group.workspace)
            result = super().generate(*args, **kwargs)
            succeeded = True
            return result
        finally:
            errors = []
            for workspace in reversed(workspaces):
                try:
                    workspace.close()
                except BaseException as error:
                    errors.append(error)
            for group in self.decoder.groups:
                group.workspace = None
            self.active_owner = None
            if succeeded:
                self.completed_workspace_requests += 1
            else:
                self.failed_workspace_requests += 1
            if errors:
                raise RuntimeError('Request workspace cleanup failed') from errors[0]


def wrap_generator(original):
    return RequestWorkspaceGenerator(original)
