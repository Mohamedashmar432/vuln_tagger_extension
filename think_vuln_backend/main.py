from fastapi import FastAPI, HTTPException, Header, Depends
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime
import secrets
import hashlib

from sqlalchemy import create_engine, Column, String, Integer, DateTime, Text, ForeignKey
from sqlalchemy.orm import sessionmaker, declarative_base, relationship, Session

# SQLite DB file in this folder
DATABASE_URL = "sqlite:///./vuln_tagger.db"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# -------------- Models --------------

class Project(Base):
    __tablename__ = "projects"
    id = Column(String, primary_key=True, index=True)      # project_id
    name = Column(String, nullable=False)
    base_url = Column(String, nullable=True)
    secret_hash = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    vulns = relationship("Vuln", back_populates="project")


class Vuln(Base):
    __tablename__ = "vulns"
    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(String, ForeignKey("projects.id"), index=True)
    page_url = Column(String, index=True)
    selector = Column(String, nullable=False)
    type = Column(String, nullable=False)
    severity = Column(String, nullable=False)
    status = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    steps = Column(Text, nullable=True)
    payload = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    project = relationship("Project", back_populates="vulns")


Base.metadata.create_all(bind=engine)

# -------------- Schemas --------------

class ProjectCreate(BaseModel):
    project_name: str
    base_url: Optional[str] = None

class ProjectResolve(BaseModel):
    project_key: str

class ProjectOut(BaseModel):
    project_id: str
    project_name: str
    base_url: Optional[str] = None
    project_key: str

class VulnIn(BaseModel):
    page_url: str
    selector: str
    type: str
    severity: str
    status: str
    description: Optional[str] = ""
    steps: Optional[str] = ""
    payload: Optional[str] = ""

class VulnOut(BaseModel):
    id: int
    page_url: str
    selector: str
    type: str
    severity: str
    status: str
    description: Optional[str]
    steps: Optional[str]
    payload: Optional[str]

    class Config:
        orm_mode = True

# -------------- Utils --------------

# IMPORTANT: change this once and keep it secret
SERVER_SALT = "change-this-to-random-secret-once"

def hash_secret(secret: str) -> str:
    return hashlib.sha256((secret + SERVER_SALT).encode()).hexdigest()

def generate_project_ids(name: str) -> (str, str):
    # short project id
    pid = "prj_" + secrets.token_hex(4)
    # random secret key for sharing
    secret = "VT-1-" + secrets.token_hex(16)
    return pid, secret

# Dependency
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def get_project_by_key(db: Session, project_id: str, project_key: str) -> Project:
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project.secret_hash != hash_secret(project_key):
        raise HTTPException(status_code=403, detail="Invalid project key")
    return project

app = FastAPI(title="Vuln Tagger Backend")

# -------------- Endpoints --------------
@app.get("/")
def root():
    return {"status": "ok", "message": "Vuln Tagger backend is running"}

@app.post("/projects/create", response_model=ProjectOut)
def create_project(payload: ProjectCreate, db: Session = Depends(get_db)):
    project_id, project_key = generate_project_ids(payload.project_name)
    secret_h = hash_secret(project_key)

    project = Project(
        id=project_id,
        name=payload.project_name,
        base_url=payload.base_url,
        secret_hash=secret_h,
    )
    db.add(project)
    db.commit()
    db.refresh(project)

    return ProjectOut(
        project_id=project.id,
        project_name=project.name,
        base_url=project.base_url,
        project_key=project_key,
    )

@app.post("/projects/resolve", response_model=ProjectOut)
def resolve_project(payload: ProjectResolve, db: Session = Depends(get_db)):
    secret_h = hash_secret(payload.project_key)
    project = db.query(Project).filter(Project.secret_hash == secret_h).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found for this key")

    return ProjectOut(
        project_id=project.id,
        project_name=project.name,
        base_url=project.base_url,
        project_key=payload.project_key,
    )

@app.get("/projects/{project_id}/vulns", response_model=List[VulnOut])
def list_vulns(
    project_id: str,
    page_url: Optional[str] = None,
    x_project_key: str = Header(..., alias="X-Project-Key"),
    db: Session = Depends(get_db),
):
    project = get_project_by_key(db, project_id, x_project_key)

    q = db.query(Vuln).filter(Vuln.project_id == project.id)
    if page_url:
        q = q.filter(Vuln.page_url == page_url)
    vulns = q.order_by(Vuln.id.desc()).all()
    return vulns

@app.post("/projects/{project_id}/vulns", response_model=VulnOut)
def create_vuln(
    project_id: str,
    vuln: VulnIn,
    x_project_key: str = Header(..., alias="X-Project-Key"),
    db: Session = Depends(get_db),
):
    project = get_project_by_key(db, project_id, x_project_key)

    v = Vuln(
        project_id=project.id,
        page_url=vuln.page_url,
        selector=vuln.selector,
        type=vuln.type,
        severity=vuln.severity,
        status=vuln.status,
        description=vuln.description,
        steps=vuln.steps,
        payload=vuln.payload,
    )
    db.add(v)
    db.commit()
    db.refresh(v)
    return v

@app.put("/projects/{project_id}/vulns/{vuln_id}", response_model=VulnOut)
def update_vuln(
    project_id: str,
    vuln_id: int,
    vuln: VulnIn,
    x_project_key: str = Header(..., alias="X-Project-Key"),
    db: Session = Depends(get_db),
):
    project = get_project_by_key(db, project_id, project_key=x_project_key)

    v = db.query(Vuln).filter(Vuln.id == vuln_id, Vuln.project_id == project.id).first()
    if not v:
        raise HTTPException(status_code=404, detail="Vuln not found")

    v.page_url = vuln.page_url
    v.selector = vuln.selector
    v.type = vuln.type
    v.severity = vuln.severity
    v.status = vuln.status
    v.description = vuln.description
    v.steps = vuln.steps
    v.payload = vuln.payload

    db.commit()
    db.refresh(v)
    return v

@app.delete("/projects/{project_id}/vulns/{vuln_id}", status_code=204)
def delete_vuln(
    project_id: str,
    vuln_id: int,
    x_project_key: str = Header(..., alias="X-Project-Key"),
    db: Session = Depends(get_db),
):
    project = get_project_by_key(db, project_id, project_key=x_project_key)

    v = db.query(Vuln).filter(Vuln.id == vuln_id, Vuln.project_id == project.id).first()
    if not v:
        raise HTTPException(status_code=404, detail="Vuln not found")

    db.delete(v)
    db.commit()
    return
