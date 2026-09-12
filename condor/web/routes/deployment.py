"""Read an operator-verified deployment receipt; never query Docker or infer versions."""
import json
import os
import stat
from datetime import datetime, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, model_validator
from condor.web.auth import get_current_user
from condor.web.models import WebUser

router = APIRouter(tags=['deployment'])


def instant(value):
    if not isinstance(value, str):
        raise ValueError('Invalid timestamp')
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None or parsed > datetime.now(timezone.utc):
        raise ValueError('Invalid timestamp')
    return value


Instant = Annotated[str, BeforeValidator(instant)]
Commit = Annotated[str, Field(pattern=r'^[a-f0-9]{40,64}$')]
Digest = Annotated[str, Field(pattern=r'^[a-f0-9]{64}$')]
ComponentId = Literal['api', 'condor', 'reporting', 'reporting-main', 'reporting-sui', 'engine', 'execution-main', 'execution-sui', 'research', 'ingress', 'broker', 'network']


class Record(BaseModel):
    model_config = ConfigDict(extra='ignore', strict=True)


class Component(Record):
    id: ComponentId
    name: str = Field(min_length=1, max_length=80)
    image_id: str = Field(pattern=r'^sha256:[a-f0-9]{64}$')
    source_manifest: Digest
    commit: Commit | None
    started_at: Instant


class Release(Record):
    root_commit: Commit
    condor_commit: Commit
    api_commit: Commit
    deployed_at: Instant


class Pending(Record):
    component: ComponentId
    reason: str = Field(min_length=1, max_length=300)


class Observation(Record):
    schema_version: Literal[1]
    observed_at: Instant
    components: list[Component] = Field(min_length=1, max_length=20)
    release: Release
    pending: list[Pending] = Field(default_factory=list, max_length=20)

    @model_validator(mode='after')
    def unique_components(self):
        if len({item.id for item in self.components}) != len(self.components):
            raise ValueError('Duplicate component')
        return self


@router.get('/deployment')
def deployment_observation(response: Response, user: WebUser = Depends(get_current_user)):
    if user.role != 'admin':
        raise HTTPException(403, detail='Administrator access required')
    response.headers['Cache-Control'] = 'no-store'
    path = os.environ.get('CONDOR_DEPLOYMENT_OBSERVATION_FILE')
    if not path:
        return {'recorded': False, 'reason': 'Deployment details have not been recorded.'}
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 65536:
                raise ValueError('Invalid receipt file')
            raw = stream.read(65537)
            if len(raw) > 65536:
                raise ValueError('Receipt too large')
        result = Observation.model_validate(json.loads(raw)).model_dump()
    except FileNotFoundError:
        return {'recorded': False, 'reason': 'Deployment details have not been recorded.'}
    except (OSError, ValueError):
        raise HTTPException(503, detail='Deployment details could not be verified. Retry after the deployment receipt is checked.', headers={'Cache-Control': 'no-store'}) from None
    return {'recorded': True, **result}
