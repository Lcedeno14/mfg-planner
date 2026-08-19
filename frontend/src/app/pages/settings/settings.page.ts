/**
 * settings.page.ts — the Setup page: manage departments and the op catalog.
 *
 * Pattern to notice: "edit in place with save-on-change". There is no Save
 * button for the lists — every input persists on its (change) event (which
 * fires on blur/Enter, not per keystroke). Failed saves alert() the server's
 * error message and reload the list, restoring the last-good state — the
 * rollback half of an optimistic UI.
 *
 * Creation goes through dialogs instead, because a half-typed new row has no
 * id to PATCH against yet; the dialog collects everything, POSTs once, then
 * reloads the list.
 *
 * Changes here shape the whole app: department color/name feed every card,
 * and catalog edits feed the Add Op picker and the suggestion engine.
 * Deliverables already on boards are untouched (they snapshot op code/name
 * at planning time — see the backend comments).
 */
import { Component, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { SelectModule } from 'primeng/select';
import { TooltipModule } from 'primeng/tooltip';
import { ApiService } from '../../api.service';
import { DepartmentInfo, OpCatalogItem } from '../../models';

@Component({
  selector: 'app-settings-page',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, DialogModule, SelectModule, TooltipModule],
  template: `
    <h1>Setup</h1>
    <p class="lede">Departments and the op catalog. Changes apply to new plans immediately — existing week boards keep the ops already placed on them.</p>

    <div class="panels">
      <!-- Departments -->
      <section class="panel">
        <div class="panel-title">
          <span>Departments</span>
          <p-button icon="pi pi-plus" label="Department" size="small" text (onClick)="openAddDept()" />
        </div>
        @for (d of depts(); track d.id) {
          <div class="row dept-row">
            <input class="color-input" type="color" [(ngModel)]="d.color" (change)="saveDept(d)"
                   pTooltip="Card color" tooltipPosition="top" aria-label="Department color" />
            <input class="text-input grow" type="text" [(ngModel)]="d.name" (change)="saveDept(d)"
                   aria-label="Department name" />
            <button class="icon-btn" (click)="removeDept(d)" aria-label="Delete department">
              <i class="pi pi-trash"></i>
            </button>
          </div>
        }
        @if (depts().length === 0) {
          <p class="empty">No departments yet.</p>
        }
      </section>

      <!-- Op catalog -->
      <section class="panel">
        <div class="panel-title">
          <span>Op catalog</span>
          <p-button icon="pi pi-plus" label="Op" size="small" text (onClick)="openAddOp()" />
        </div>
        <table class="op-table">
          <thead>
            <tr>
              <th class="col-code">Op code</th>
              <th>Name</th>
              <th class="col-dept">Department</th>
              <th class="col-hours">Avg hrs</th>
              <th class="col-del"></th>
            </tr>
          </thead>
          <tbody>
            @for (op of ops(); track op.id) {
              <tr>
                <td><input class="text-input code" type="text" [(ngModel)]="op.op_code" (change)="saveOp(op)" aria-label="Op code" /></td>
                <td><input class="text-input" type="text" [(ngModel)]="op.op_name" (change)="saveOp(op)" aria-label="Op name" /></td>
                <td>
                  <p-select [options]="depts()" [(ngModel)]="op.department_id" optionLabel="name" optionValue="id"
                            (onChange)="saveOp(op)" appendTo="body" styleClass="dept-select">
                    <ng-template #selectedItem let-d>
                      <span class="dept-opt"><span class="dept-dot" [style.background]="d.color"></span>{{ d.name }}</span>
                    </ng-template>
                    <ng-template #item let-d>
                      <span class="dept-opt"><span class="dept-dot" [style.background]="d.color"></span>{{ d.name }}</span>
                    </ng-template>
                  </p-select>
                </td>
                <td><input class="num-input" type="number" min="0" step="0.5" [(ngModel)]="op.avg_labor_hours"
                           (change)="saveOp(op)" aria-label="Average labor hours" /></td>
                <td>
                  <button class="icon-btn" (click)="removeOp(op)" aria-label="Delete op">
                    <i class="pi pi-trash"></i>
                  </button>
                </td>
              </tr>
            }
          </tbody>
        </table>
        @if (ops().length === 0) {
          <p class="empty">No ops in the catalog.</p>
        }
      </section>
    </div>

    <!-- Add department dialog -->
    <p-dialog [visible]="addDeptOpen()" (visibleChange)="addDeptOpen.set($event)" [modal]="true"
              header="New department" [style]="{ width: '24rem' }">
      <div class="dialog-form">
        <label>Name</label>
        <input class="text-input" type="text" [(ngModel)]="newDeptName" placeholder="e.g. Assembly"
               (keyup.enter)="confirmAddDept()" />
        <label>Color</label>
        <input class="color-input big" type="color" [(ngModel)]="newDeptColor" />
      </div>
      <ng-template #footer>
        <p-button label="Cancel" text (onClick)="addDeptOpen.set(false)" />
        <p-button label="Add department" [disabled]="!newDeptName.trim()" (onClick)="confirmAddDept()" />
      </ng-template>
    </p-dialog>

    <!-- Add op dialog -->
    <p-dialog [visible]="addOpOpen()" (visibleChange)="addOpOpen.set($event)" [modal]="true"
              header="New op" [style]="{ width: '26rem' }">
      <div class="dialog-form">
        <label>Department</label>
        <p-select [options]="depts()" [(ngModel)]="newOpDeptId" optionLabel="name" optionValue="id"
                  placeholder="Pick a department" appendTo="body" styleClass="w-full">
          <ng-template #selectedItem let-d>
            <span class="dept-opt"><span class="dept-dot" [style.background]="d.color"></span>{{ d.name }}</span>
          </ng-template>
          <ng-template #item let-d>
            <span class="dept-opt"><span class="dept-dot" [style.background]="d.color"></span>{{ d.name }}</span>
          </ng-template>
        </p-select>
        <label>Op code</label>
        <input class="text-input" type="text" [(ngModel)]="newOpCode" placeholder="e.g. Op 320" />
        <label>Op name</label>
        <input class="text-input" type="text" [(ngModel)]="newOpName" placeholder="e.g. Stress Relief" />
        <label>Avg labor hours</label>
        <input class="num-input wide" type="number" min="0" step="0.5" [(ngModel)]="newOpHours" />
      </div>
      <ng-template #footer>
        <p-button label="Cancel" text (onClick)="addOpOpen.set(false)" />
        <p-button label="Add op" [disabled]="!newOpDeptId || !newOpCode.trim()" (onClick)="confirmAddOp()" />
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    h1 { font-family: var(--display); text-transform: uppercase; letter-spacing: 0.04em; margin: 0 0 0.3rem; }
    .lede { color: var(--ink-soft); font-size: 0.88rem; margin: 0 0 1.2rem; max-width: 46rem; }
    .panels { display: grid; grid-template-columns: minmax(280px, 22rem) minmax(320px, 1fr); gap: 1rem; align-items: start; }
    @media (max-width: 800px) { .panels { grid-template-columns: 1fr; } }
    .panel { background: var(--panel); border: 1px solid var(--rule); border-radius: 10px; padding: 0.9rem 1rem; }
    .panel-title {
      display: flex; align-items: center; justify-content: space-between;
      font-family: var(--display); font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.08em; font-size: 0.85rem; color: var(--ink-soft); margin-bottom: 0.6rem;
    }
    .row { display: flex; align-items: center; gap: 0.5rem; padding: 0.25rem 0; }
    .grow { flex: 1; }
    .text-input {
      border: 1px solid var(--rule); border-radius: 6px; padding: 0.35rem 0.5rem;
      font: inherit; font-size: 0.88rem; background: var(--panel); color: inherit; width: 100%;
    }
    .text-input.code { width: 5.5rem; }
    .num-input { width: 4.5rem; border: 1px solid var(--rule); border-radius: 6px; padding: 0.35rem 0.4rem; font: inherit; font-size: 0.88rem; }
    .num-input.wide { width: 100%; }
    .color-input {
      width: 2rem; height: 2rem; padding: 0; border: 1px solid var(--rule); border-radius: 6px;
      background: none; cursor: pointer; flex: none;
    }
    .color-input.big { width: 3rem; height: 2.2rem; }
    .icon-btn {
      border: none; background: none; color: var(--ink-soft); cursor: pointer;
      padding: 0.3rem; border-radius: 6px; flex: none;
    }
    .icon-btn:hover { background: rgba(0,0,0,0.06); color: #b3261e; }
    .op-table { width: 100%; border-collapse: collapse; }
    .op-table th {
      text-align: left; font-size: 0.7rem; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--ink-soft); padding: 0.25rem 0.3rem;
    }
    .op-table td { padding: 0.2rem 0.3rem; vertical-align: middle; }
    .col-code { width: 6rem; }
    .col-dept { width: 11rem; }
    .col-hours { width: 5rem; }
    .col-del { width: 2.2rem; }
    :host ::ng-deep .dept-select { width: 100%; }
    .empty { color: var(--ink-soft); font-size: 0.85rem; }
    .dept-opt { display: inline-flex; align-items: center; gap: 0.45rem; }
    .dept-dot { width: 10px; height: 10px; border-radius: 3px; flex: none; }
    .dialog-form { display: flex; flex-direction: column; gap: 0.5rem; }
    .dialog-form label {
      font-size: 0.72rem; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--ink-soft);
    }
  `],
})
export class SettingsPage implements OnInit {
  depts = signal<DepartmentInfo[]>([]);
  ops = signal<OpCatalogItem[]>([]);

  addDeptOpen = signal(false);
  newDeptName = '';
  newDeptColor = '#0078a9';

  addOpOpen = signal(false);
  newOpDeptId: number | null = null;
  newOpCode = '';
  newOpName = '';
  newOpHours = 0;

  constructor(private api: ApiService) {}

  ngOnInit() {
    this.load();
  }

  load() {
    this.api.departments().subscribe(d => this.depts.set(d));
    this.api.ops().subscribe(o => this.ops.set(this.sortOps(o)));
  }

  /** Numeric-aware op-code order, so "Op 9" sorts before "Op 105". */
  private sortOps(list: OpCatalogItem[]): OpCatalogItem[] {
    return [...list].sort((a, b) => a.op_code.localeCompare(b.op_code, undefined, { numeric: true }));
  }

  // ----- departments -----
  openAddDept() {
    this.newDeptName = '';
    this.newDeptColor = '#0078a9';
    this.addDeptOpen.set(true);
  }

  confirmAddDept() {
    const name = this.newDeptName.trim();
    if (!name) return;
    this.api.createDepartment({ name, color: this.newDeptColor }).subscribe({
      next: () => { this.addDeptOpen.set(false); this.load(); },
      error: err => alert(err?.error?.error ?? 'Could not add the department'),
    });
  }

  saveDept(d: DepartmentInfo) {
    // ngModel already updated the local object (the UI shows the edit);
    // on failure, alert + reload rolls the list back to server truth.
    this.api.updateDepartment(d.id, { name: d.name, color: d.color }).subscribe({
      error: err => { alert(err?.error?.error ?? 'Could not save'); this.load(); },
    });
  }

  removeDept(d: DepartmentInfo) {
    // Spell out the blast radius: this cascades across every week's board.
    if (!confirm(`Delete ${d.name}? This removes its ops from the catalog and its deliverables and daily plans from every week.`)) return;
    this.api.deleteDepartment(d.id).subscribe(() => this.load());
  }

  // ----- ops -----
  openAddOp() {
    this.newOpDeptId = this.depts()[0]?.id ?? null;
    this.newOpCode = '';
    this.newOpName = '';
    this.newOpHours = 0;
    this.addOpOpen.set(true);
  }

  confirmAddOp() {
    if (!this.newOpDeptId || !this.newOpCode.trim()) return;
    this.api.createOp({
      department_id: this.newOpDeptId,
      op_code: this.newOpCode.trim(),
      op_name: this.newOpName.trim(),
      avg_labor_hours: this.newOpHours || 0,
    }).subscribe({
      next: () => { this.addOpOpen.set(false); this.load(); },
      error: err => alert(err?.error?.error ?? 'Could not add the op'),
    });
  }

  saveOp(op: OpCatalogItem) {
    this.api.updateOp(op.id, {
      department_id: op.department_id,
      op_code: op.op_code,
      op_name: op.op_name,
      avg_labor_hours: op.avg_labor_hours,
    }).subscribe({
      next: () => this.ops.set(this.sortOps(this.ops())),
      error: err => { alert(err?.error?.error ?? 'Could not save'); this.load(); },
    });
  }

  removeOp(op: OpCatalogItem) {
    if (!confirm(`Delete ${op.op_code} ${op.op_name} from the catalog? Deliverables already on week boards keep it.`)) return;
    this.api.deleteOp(op.id).subscribe(() => this.load());
  }
}
