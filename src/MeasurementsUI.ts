import {
  IViewer,
  MeasurementsExtension,
  MeasurementType,
  Units,
} from '@speckle/viewer';
import { Pane } from 'tweakpane';

export const measurementsParams = {
  type: MeasurementType.POINTTOPOINT,
  vertexSnap: true,
  units: 'm',
  precision: 2,
  visible: true,
  enabled: true,
};

export function makeMeasurementsUI(viewer: IViewer) {
  const measurementsExtension = viewer.getExtension(
    MeasurementsExtension
  ) as MeasurementsExtension;
  const pane = new Pane({ title: 'Mesurements', expanded: true });
  pane
    .addInput(measurementsParams, 'enabled', {
      label: 'Enabled',
    })
    .on('change', () => {
      measurementsExtension.enabled = measurementsParams.enabled;
    });
  pane
    .addInput(measurementsParams, 'visible', {
      label: 'Visible',
    })
    .on('change', () => {
      measurementsExtension.options = measurementsParams;
    });
  pane
    .addInput(measurementsParams, 'type', {
      label: 'Type',
      options: {
        PERPENDICULAR: MeasurementType.PERPENDICULAR,
        POINTTOPOINT: MeasurementType.POINTTOPOINT,
      },
    })
    .on('change', () => {
      measurementsExtension.options = measurementsParams;
    });
  pane
    .addInput(measurementsParams, 'vertexSnap', {
      label: 'Snap',
    })
    .on('change', () => {
      measurementsExtension.options = measurementsParams;
    });

  pane
    .addInput(measurementsParams, 'units', {
      label: 'Units',
      options: Units,
    })
    .on('change', () => {
      measurementsExtension.options = measurementsParams;
    });
  pane
    .addInput(measurementsParams, 'precision', {
      label: 'Precision',
      step: 1,
      min: 1,
      max: 5,
    })
    .on('change', () => {
      measurementsExtension.options = measurementsParams;
    });
  pane
    .addButton({
      title: 'Delete',
    })
    .on('click', () => {
      measurementsExtension.removeMeasurement();
    });
  pane
    .addButton({
      title: 'Delete All',
    })
    .on('click', () => {
      measurementsExtension.clearMeasurements();
    });
}
