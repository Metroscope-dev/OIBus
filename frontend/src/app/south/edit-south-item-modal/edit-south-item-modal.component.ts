import { Component, inject } from '@angular/core';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { AbstractControl, FormControl, FormGroup, NonNullableFormBuilder, ValidationErrors, ValidatorFn, Validators } from '@angular/forms';
import { Observable } from 'rxjs';
import { ObservableState, SaveButtonComponent } from '../../shared/save-button/save-button.component';
import { TranslateDirective, TranslatePipe } from '@ngx-translate/core';
import { formDirectives } from '../../shared/form-directives';
import {
  SouthConnectorCommandDTO,
  SouthConnectorItemCommandDTO,
  SouthConnectorItemDTO,
  SouthConnectorItemManifest,
  SouthConnectorManifest,
  AvailablePoint
} from '../../../../../backend/shared/model/south-connector.model';
import { ScanModeDTO } from '../../../../../backend/shared/model/scan-mode.model';

import { createFormGroup, createFormGroupWithMqttValidation, groupFormControlsByRow } from '../../shared/form-utils';
import { OibScanModeComponent } from '../../shared/form/oib-scan-mode/oib-scan-mode.component';
import { Timezone } from '../../../../../backend/shared/model/types';
import { inMemoryTypeahead } from '../../shared/typeahead';
import { OibFormControl } from '../../../../../backend/shared/model/form.model';
import { FormComponent } from '../../shared/form/form.component';
import { SouthItemSettings, SouthSettings } from '../../../../../backend/shared/model/south-settings.model';
import { SouthItemTestComponent } from '../south-item-test/south-item-test.component';
import { UnsavedChangesConfirmationService } from '../../shared/unsaved-changes-confirmation.service';
import { SouthConnectorService } from '../../services/south-connector.service';
import { FormsModule } from '@angular/forms';

// TypeScript issue with Intl: https://github.com/microsoft/TypeScript/issues/49231
// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace Intl {
  type Key = 'calendar' | 'collation' | 'currency' | 'numberingSystem' | 'timeZone' | 'unit';

  function supportedValuesOf(input: Key): Array<string>;
}

@Component({
  selector: 'oib-edit-south-item-modal',
  templateUrl: './edit-south-item-modal.component.html',
  styleUrl: './edit-south-item-modal.component.scss',
  imports: [
    ...formDirectives,
    TranslateDirective,
    SaveButtonComponent,
    OibScanModeComponent,
    FormComponent,
    SouthItemTestComponent,
    TranslatePipe,
    FormsModule
  ]
})
export class EditSouthItemModalComponent {
  private modal = inject(NgbActiveModal);
  private fb = inject(NonNullableFormBuilder);
  private unsavedChangesConfirmation = inject(UnsavedChangesConfirmationService);
  private southConnectorService = inject(SouthConnectorService);

  mode: 'create' | 'edit' | 'copy' = 'create';
  state = new ObservableState();

  scanModes: Array<ScanModeDTO> = [];
  southItemSchema: SouthConnectorItemManifest | null = null;
  southItemRows: Array<Array<OibFormControl>> = [];

  southId!: string;
  southConnectorCommand!: SouthConnectorCommandDTO<SouthSettings, SouthItemSettings>;
  southManifest!: SouthConnectorManifest;
  item: SouthConnectorItemDTO<SouthItemSettings> | SouthConnectorItemCommandDTO<SouthItemSettings> | null = null;
  itemList: Array<SouthConnectorItemDTO<SouthItemSettings> | SouthConnectorItemCommandDTO<SouthItemSettings>> = [];

  /** Not every item passed will have an id, but we still need to check for uniqueness.
   * This ensures that we have a backup identifier for the currently edited item.
   * In 'copy' and 'create' cases, we always check all items' names
   */
  tableIndex: number | null = null;

  form: FormGroup<{
    name: FormControl<string>;
    scanModeId: FormControl<string | null>;
    enabled: FormControl<boolean>;
    settings: FormGroup;
  }> | null = null;

  // Browse items functionality
  availablePoints: Array<AvailablePoint> = [];
  browsingItems = false;
  browseError: string | null = null;
  nameFilter = '*';
  selectedPoint: AvailablePoint | null = null;
  selectedPointsForBatch: Array<SouthConnectorItemCommandDTO<SouthItemSettings>> = [];
  batchSelectionMessage: string | null = null;

  private timezones: ReadonlyArray<Timezone> = Intl.supportedValuesOf('timeZone');
  timezoneTypeahead: (text$: Observable<string>) => Observable<Array<Timezone>> = inMemoryTypeahead(
    () => ['UTC', ...this.timezones],
    timezone => timezone
  );

  private checkUniqueness(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      let names!: Array<string>;

      switch (this.mode) {
        case 'copy':
        case 'create':
          names = this.itemList.map(item => item.name);
          break;
        case 'edit':
          if (this.item!.id) {
            names = this.itemList.filter(item => item.id && item.id !== this.item?.id).map(item => item.name);
          }
          names = this.itemList.filter((_, index) => index !== this.tableIndex).map(item => item.name);
          break;
      }

      return names.includes(control.value) ? { mustBeUnique: true } : null;
    };
  }

  private getExistingMqttTopics(): Array<string> {
    let existingTopics: Array<string> = [];

    switch (this.mode) {
      case 'copy':
      case 'create':
        existingTopics = this.itemList
          .map(item => (item.settings as any)?.topic)
          .filter(topic => topic && typeof topic === 'string' && topic.trim());
        break;
      case 'edit':
        if (this.item?.id) {
          existingTopics = this.itemList
            .filter(item => item.id && item.id !== this.item?.id)
            .map(item => (item.settings as any)?.topic)
            .filter(topic => topic && typeof topic === 'string' && topic.trim());
        } else {
          existingTopics = this.itemList
            .filter((_, index) => index !== this.tableIndex)
            .map(item => (item.settings as any)?.topic)
            .filter(topic => topic && typeof topic === 'string' && topic.trim());
        }
        break;
    }

    return existingTopics;
  }

  private createForm(item: SouthConnectorItemDTO<SouthItemSettings> | SouthConnectorItemCommandDTO<SouthItemSettings> | null) {
    const existingTopics = this.southManifest?.id === 'mqtt' ? this.getExistingMqttTopics() : [];

    this.form = this.fb.group({
      name: ['', [Validators.required, this.checkUniqueness()]],
      enabled: [true, Validators.required],
      scanModeId: this.fb.control<string | null>(null, Validators.required),
      settings:
        this.southManifest?.id === 'mqtt'
          ? createFormGroupWithMqttValidation(this.southItemSchema!.settings, this.fb, existingTopics)
          : createFormGroup(this.southItemSchema!.settings, this.fb)
    });

    if (this.southItemSchema!.scanMode === 'SUBSCRIPTION') {
      this.form.controls.scanModeId.disable();
    } else {
      this.form.controls.scanModeId.enable();
    }

    // if we have an item we initialize the values
    if (item) {
      this.form.patchValue(item);
    } else {
      this.form.setValue(this.form.getRawValue());
    }
  }

  /**
   * Prepares the component for creation.
   */
  prepareForCreation(
    southItemSchema: SouthConnectorItemManifest,
    itemList: Array<SouthConnectorItemDTO<SouthItemSettings> | SouthConnectorItemCommandDTO<SouthItemSettings>>,
    scanModes: Array<ScanModeDTO>,
    southId: string,
    southConnectorCommand: SouthConnectorCommandDTO<SouthSettings, SouthItemSettings>,
    southManifest: SouthConnectorManifest
  ) {
    this.mode = 'create';
    this.itemList = itemList;
    this.southId = southId;
    this.southConnectorCommand = southConnectorCommand;
    this.southManifest = southManifest;
    this.southItemRows = groupFormControlsByRow(southItemSchema.settings);
    this.southItemSchema = southItemSchema;
    this.scanModes = scanModes;
    this.createForm(null);
  }

  /**
   * Prepares the component for edition.
   * tableIndex is an additional identifier, when item ids are not available. This indexes the given itemList param
   */
  prepareForEdition(
    southItemSchema: SouthConnectorItemManifest,
    itemList: Array<SouthConnectorItemDTO<SouthItemSettings> | SouthConnectorItemCommandDTO<SouthItemSettings>>,
    scanModes: Array<ScanModeDTO>,
    southItem: SouthConnectorItemDTO<SouthItemSettings> | SouthConnectorItemCommandDTO<SouthItemSettings>,
    southId: string,
    southConnectorCommand: SouthConnectorCommandDTO<SouthSettings, SouthItemSettings>,
    southManifest: SouthConnectorManifest,
    tableIndex: number
  ) {
    this.mode = 'edit';
    this.itemList = itemList;
    this.southId = southId;
    this.southConnectorCommand = southConnectorCommand;
    this.southManifest = southManifest;
    this.item = southItem;
    this.southItemRows = groupFormControlsByRow(southItemSchema.settings);
    this.southItemSchema = southItemSchema;
    this.scanModes = scanModes;
    this.createForm(southItem);
    this.tableIndex = tableIndex;
  }

  /**
   * Prepares the component for edition.
   */
  prepareForCopy(
    southItemSchema: SouthConnectorItemManifest,
    itemList: Array<SouthConnectorItemDTO<SouthItemSettings> | SouthConnectorItemCommandDTO<SouthItemSettings>>,
    scanModes: Array<ScanModeDTO>,
    southItem: SouthConnectorItemDTO<SouthItemSettings> | SouthConnectorItemCommandDTO<SouthItemSettings>,
    southId: string,
    southConnectorCommand: SouthConnectorCommandDTO<SouthSettings, SouthItemSettings>,
    southManifest: SouthConnectorManifest
  ) {
    this.southId = southId;
    this.southConnectorCommand = southConnectorCommand;
    this.southManifest = southManifest;
    this.item = JSON.parse(JSON.stringify(southItem)) as SouthConnectorItemDTO<SouthItemSettings>;
    this.item.name = `${southItem.name}-copy`;
    this.mode = 'copy';
    this.itemList = itemList;
    this.southItemSchema = southItemSchema;
    this.southItemRows = groupFormControlsByRow(southItemSchema.settings);
    this.scanModes = scanModes;
    this.createForm(this.item);
  }

  canDismiss(): Observable<boolean> | boolean {
    if (this.form?.dirty) {
      return this.unsavedChangesConfirmation.confirmUnsavedChanges();
    }
    return true;
  }

  cancel() {
    this.modal.dismiss();
  }

  save() {
    if (!this.form!.valid) {
      return;
    }

    // If we have batch selected points, return them for batch creation
    if (this.selectedPointsForBatch.length > 0) {
      this.modal.close({ selectAll: true, items: this.selectedPointsForBatch });
      return;
    }

    this.modal.close(this.formItem);
  }

  get formItem(): SouthConnectorItemCommandDTO<SouthItemSettings> {
    const formValue = this.form!.value;
    let id: string | null = null;
    if (this.mode === 'edit') {
      id = this.item?.id || null;
    }

    const settings = { ...formValue.settings! };
    
    // For PI Web API, add the selected point's webId
    if (this.southManifest?.id === 'osisoft-pi-webapi' && this.selectedPoint) {
      settings.pointWebId = this.selectedPoint.webId || this.selectedPoint.id;
    }

    return {
      id,
      enabled: formValue.enabled!,
      name: formValue.name!,
      scanModeId: this.southItemSchema!.scanMode === 'SUBSCRIPTION' ? 'subscription' : formValue.scanModeId!,
      scanModeName: null,
      settings
    };
  }

  // Browse items functionality
  browseItems() {
    if (!this.southConnectorCommand) {
      return;
    }

    this.browsingItems = true;
    this.browseError = null;
    this.availablePoints = [];

    const params = {
      nameFilter: this.nameFilter,
      maxPoints: 1000
    };

    this.southConnectorService.browseAvailableItems(this.southId, this.southConnectorCommand, params).subscribe({
      next: (points: Array<AvailablePoint>) => {
        this.availablePoints = points;
        this.browsingItems = false;
      },
      error: error => {
        this.browseError = error.error?.message || error.message || 'Failed to browse available items';
        this.browsingItems = false;
      }
    });
  }

  selectPoint(point: AvailablePoint) {
    // Store the selected point for later use
    this.selectedPoint = point;

    // Check if form is initialized before accessing controls
    if (!this.form) {
      return;
    }

    // Set the name to the point name
    const nameControl = this.form.get('name');
    if (nameControl) {
      nameControl.setValue(point.name);
    }

    // Update the form settings to include the pointWebId
    const settingsControl = this.form.get('settings');
    if (settingsControl) {
      const currentSettings = settingsControl.value || {};
      settingsControl.setValue({
        ...currentSettings,
        pointWebId: point.webId || point.id
      });
      settingsControl.markAsDirty();
    }
  }

  selectAllItems() {
    if (this.availablePoints.length === 0) {
      return;
    }

    // Store all points for batch creation
    this.selectedPointsForBatch = this.availablePoints.map(point => ({
      id: null,
      enabled: true,
      name: point.name,
      scanModeId: this.southItemSchema!.scanMode === 'SUBSCRIPTION' ? 'subscription' : this.form?.get('scanModeId')?.value || null,
      scanModeName: null,
      settings: {
        pointWebId: point.webId || point.id
      }
    }));

    // Show confirmation message
    this.batchSelectionMessage = `Selected ${this.availablePoints.length} items for batch creation. Save to add all items.`;
  }
}
